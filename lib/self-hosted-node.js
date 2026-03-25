import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

import seedState from '@/data/node0-state.json';
import {
  computeBlockHash,
  createConsensusVotePayload,
  isValidChain,
  normalizeChain,
  signBlockPayload,
  signConsensusPayload,
  stableStringify,
  verifyConsensusSignature,
} from '@/lib/chain-security';
import { createIntegritySnapshot } from '@/lib/integrity';
import { incrementCounter, logEvent } from '@/lib/observability';
import { getConfiguredNodeSigner, getFeeConfig, getGenesisNode0Url, getKeyStoreDir, getMediaUploadPolicy, getNode0RegistrationSecret, getNode0RegistrationTargets, getPublicBaseUrl, getStorageDir } from '@/lib/runtime-config';
import { createFederationApi } from '@/lib/self-hosted/federation';
import { createOperatorApi } from '@/lib/self-hosted/operator';
import { createPersistenceApi } from '@/lib/self-hosted/persistence';
import { createWalletKeypair, getPublicKeyFromPrivateKey, signTransactionPayload, verifyTransactionSignature } from '@/lib/transaction-security';

const LEGACY_STATE_FILE = 'state.json';
const STATE_DB_FILE = 'state.sqlite';
const MEDIA_DIR = 'media';
const INITIAL_BALANCE = 10;
const INITIAL_VALIDATOR_BOND = 5;
const VALIDATION_TARGET = 2;
const ESCALATED_VALIDATION_TARGET = 3;
const UPLOADER_REWARD = 2;
const VALIDATOR_REWARD = 1;
const MODERATION_REWARD_POOL = 3;
const CHALLENGE_SUCCESS_REWARD = 1;
const MIN_VALIDATOR_STAKE = 5;
const VALIDATOR_SLASH = 2;
const DEFAULT_CHAIN_HEAD_QUORUM = 2;
const MIN_PERSONHOOD_ATTESTATIONS = 2;
const LOW_RISK_AUTO_APPROVAL_THRESHOLD = 2;
const CONSENSUS_PROTOCOL = 'streamchain-hotstuff-lite';
const BOOTSTRAP_VALIDATOR_ADDRESS = '__bootstrap_node_signer__';
const CONSENSUS_VOTE_JOURNAL_LIMIT = 512;
const CONSENSUS_EVIDENCE_LIMIT = 128;
const PEER_ANNOUNCEMENT_LIMIT = 128;
const APP_SNAPSHOT_INTERVAL = 1;
const MODERATION_POLICY_VERSION = '1.3';
const CHALLENGE_BOND = 1;
const APPEAL_BOND = 1;
const MAX_CASE_APPEALS = 2;
const PEER_ANNOUNCEMENT_TTL_MS = 1000 * 60 * 30;
const ADMIN_ACTION_LOG_LIMIT = 250;
const MODERATION_REASON_CODES = new Set([
  'copyright-duplicate',
  'explicit-sexual-content',
  'graphic-violence',
  'fraudulent-edit',
  'identity-misuse',
  'policy-other',
]);

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function roundAmount(value) {
  return Number(Number(value).toFixed(4));
}

function sanitizeWallet(wallet) {
  const { secretHash, nextNonce, consensusPrivateKey, privateKey, ...publicWallet } = wallet;
  return publicWallet;
}

function sanitizeNetwork(network) {
  const { nodeSignerPrivateKey, ...publicNetwork } = network || {};
  return publicNetwork;
}

function normalizeAdminActionEntry(entry = {}) {
  return {
    id: entry.id || randomUUID(),
    action: entry.action || 'unknown',
    actorAddress: entry.actorAddress || null,
    actorUsername: entry.actorUsername || null,
    targetType: entry.targetType || null,
    targetId: entry.targetId || null,
    reason: entry.reason || null,
    status: entry.status || 'accepted',
    createdAt: entry.createdAt || new Date().toISOString(),
    metadata: entry.metadata && typeof entry.metadata === 'object' ? structuredClone(entry.metadata) : {},
  };
}

function recordAdminAction(state, entry = {}) {
  const normalized = normalizeAdminActionEntry(entry);
  state.adminActionLog = [
    normalized,
    ...(state.adminActionLog || []).map((item) => normalizeAdminActionEntry(item)),
  ].slice(0, ADMIN_ACTION_LOG_LIMIT);

  incrementCounter('streamchain_admin_actions_total', {
    action: normalized.action,
    status: normalized.status,
  });
  logEvent(normalized.status === 'failed' ? 'warn' : 'info', 'admin_action_recorded', {
    action: normalized.action,
    actorAddress: normalized.actorAddress,
    actorUsername: normalized.actorUsername,
    targetType: normalized.targetType,
    targetId: normalized.targetId,
    status: normalized.status,
  });

  return normalized;
}

function sanitizeConsensusRegistryEntry(entry = {}) {
  return {
    validatorAddress: entry.validatorAddress || null,
    validatorName: entry.validatorName || entry.validatorAddress || 'validator',
    consensusPublicKey: entry.consensusPublicKey || null,
    stake: roundAmount(Number(entry.stake || 0)),
    votingPower: Math.max(0, Number(entry.votingPower || 0)),
    status: entry.status || 'inactive',
    joinedAt: entry.joinedAt || null,
    activatedAt: entry.activatedAt || null,
    source: entry.source || 'wallet',
  };
}

function sanitizeValidatorProfile(profile) {
  if (!profile) {
    return {
      status: 'provisional',
      humanIdentityCommitment: null,
      attestedBy: [],
      attestationsCount: 0,
      uniquenessViolations: 0,
      antiSybilScore: 0,
      activatedAt: null,
    };
  }

  return {
    status: profile.status || 'provisional',
    humanIdentityCommitment: profile.humanIdentityCommitment || null,
    attestedBy: sortUnique(profile.attestedBy || []),
    attestationsCount: Number(profile.attestationsCount || 0),
    uniquenessViolations: Number(profile.uniquenessViolations || 0),
    antiSybilScore: Number(profile.antiSybilScore || 0),
    activatedAt: profile.activatedAt || null,
  };
}

function sanitizeListing(listing) {
  return {
    ...listing,
    purchaseHistory: (listing.purchaseHistory || []).map((purchase) => ({
      id: purchase.id,
      buyerAddress: purchase.buyerAddress,
      buyerName: purchase.buyerName,
      sellerAddress: purchase.sellerAddress,
      sellerName: purchase.sellerName,
      creatorAddress: purchase.creatorAddress,
      creatorName: purchase.creatorName,
      grossAmount: purchase.grossAmount,
      sellerAmount: purchase.sellerAmount,
      royaltyAmount: purchase.royaltyAmount,
      marketplaceFeeAmount: purchase.marketplaceFeeAmount,
      purchasedAt: purchase.purchasedAt,
      transactionId: purchase.transactionId,
      saleType: purchase.saleType || 'primary',
      resaleLevel: purchase.resaleLevel || 0,
    })),
  };
}

function getVideoOwnershipHistory(video) {
  if (Array.isArray(video?.ownershipHistory) && video.ownershipHistory.length > 0) {
    return video.ownershipHistory;
  }

  if (!video) {
    return [];
  }

  return [
    {
      id: `mint-${video.proof || sha256(`${video.title || 'video'}:${video.url || ''}`).slice(0, 12)}`,
      ownerAddress: video.ownerAddress || video.creatorAddress || null,
      ownerName: video.owner || video.creatorName || null,
      acquiredAt: video.approvedAt || null,
      reason: 'mint',
    },
  ];
}

function getVideoTransferCount(video) {
  return Math.max(0, getVideoOwnershipHistory(video).length - 1);
}

function getListingSaleType(video, sellerAddress) {
  return sellerAddress === (video?.creatorAddress || sellerAddress) && getVideoTransferCount(video) === 0
    ? 'primary'
    : 'resale';
}

function buildWalletAnalytics(state) {
  const listingPurchases = (state.listings || []).flatMap((listing) =>
    (listing.purchaseHistory || []).map((purchase) => ({
      ...purchase,
      listingId: listing.id,
      videoProof: listing.videoProof,
      title: listing.title,
    }))
  );
  const validationResults = [
    ...(state.featuredVideos || []).flatMap((video) =>
      (video.validations || []).map((validation) => ({
        ...validation,
        outcome: 'approved',
        aligned: validation.authenticity === 'approve' && !validation.manipulated && !validation.duplicate,
      }))
    ),
    ...((state.rejectedVideos || []).flatMap((video) =>
      (video.validations || []).map((validation) => ({
        ...validation,
        outcome: 'rejected',
        aligned: !(validation.authenticity === 'approve' && !validation.manipulated && !validation.duplicate),
      }))
    )),
  ];

  return new Map(
    (state.wallets || []).map((wallet) => {
      const walletSales = listingPurchases.filter((purchase) => purchase.sellerAddress === wallet.address);
      const walletPurchases = listingPurchases.filter((purchase) => purchase.buyerAddress === wallet.address);
      const walletRoyalties = listingPurchases.filter((purchase) => purchase.creatorAddress === wallet.address);
      const walletValidations = validationResults.filter((validation) => validation.validatorAddress === wallet.address);
      const approvedUploads = (state.featuredVideos || []).filter((video) => video.creatorAddress === wallet.address).length;
      const rejectedUploads = (state.rejectedVideos || []).filter((video) => video.ownerAddress === wallet.address).length;
      const activeListings = (state.listings || []).filter((listing) => listing.sellerAddress === wallet.address && listing.status === 'active').length;
      const soldListings = (state.listings || []).filter((listing) => listing.sellerAddress === wallet.address && listing.status === 'sold').length;
      const ownedVideos = (state.featuredVideos || []).filter((video) => video.ownerAddress === wallet.address).length;
      const transferFeesPaid = (state.transactions || [])
        .filter((transaction) => transaction.senderAddress === wallet.address)
        .reduce((sum, transaction) => sum + Number(transaction.feeAmount || 0), 0);
      const primarySales = walletSales.filter((purchase) => (purchase.saleType || 'primary') === 'primary');
      const resaleSales = walletSales.filter((purchase) => (purchase.saleType || 'primary') === 'resale');
      const lastActivityAt = [
        wallet.createdAt,
        ...walletSales.map((purchase) => purchase.purchasedAt),
        ...walletPurchases.map((purchase) => purchase.purchasedAt),
        ...walletValidations.map((validation) => validation.timestamp),
        ...(state.transactions || []).filter((transaction) => transaction.senderAddress === wallet.address || transaction.receiverAddress === wallet.address).map((transaction) => transaction.timestamp),
      ].filter(Boolean).sort().at(-1) || null;
      const baseReputation = Number(wallet.reputation || 0);
      const reputationScore = roundAmount(Math.max(
        0,
        baseReputation
          + (approvedUploads * 4)
          - (rejectedUploads * 1.5)
          + (walletValidations.filter((validation) => validation.aligned).length * 2)
          - (walletValidations.filter((validation) => !validation.aligned).length)
          + (primarySales.length * 2)
          + (resaleSales.length * 3)
          + (ownedVideos * 0.5)
          + (walletRoyalties.reduce((sum, purchase) => sum + Number(purchase.royaltyAmount || 0), 0) * 0.2)
      ));

      return [wallet.address, {
        approvedUploads,
        rejectedUploads,
        activeListings,
        soldListings,
        purchasesCount: walletPurchases.length,
        primarySalesCount: primarySales.length,
        resaleSalesCount: resaleSales.length,
        validationsCount: walletValidations.length,
        alignedValidations: walletValidations.filter((validation) => validation.aligned).length,
        challengedValidations: walletValidations.filter((validation) => !validation.aligned).length,
        grossVolumeBought: roundAmount(walletPurchases.reduce((sum, purchase) => sum + Number(purchase.grossAmount || 0), 0)),
        grossVolumeSold: roundAmount(walletSales.reduce((sum, purchase) => sum + Number(purchase.grossAmount || 0), 0)),
        sellerEarnings: roundAmount(walletSales.reduce((sum, purchase) => sum + Number(purchase.sellerAmount || 0), 0)),
        royaltiesEarned: roundAmount(walletRoyalties.reduce((sum, purchase) => sum + Number(purchase.royaltyAmount || 0), 0)),
        transferFeesPaid: roundAmount(transferFeesPaid),
        ownedVideos,
        lastActivityAt,
        reputationScore,
      }];
    })
  );
}

function buildNetworkMetrics(state, walletAnalytics) {
  const purchases = (state.listings || []).flatMap((listing) => listing.purchaseHistory || []);
  const primarySales = purchases.filter((purchase) => (purchase.saleType || 'primary') === 'primary');
  const resaleSales = purchases.filter((purchase) => (purchase.saleType || 'primary') === 'resale');
  const transferFeesCollected = roundAmount((state.transactions || [])
    .filter((transaction) => transaction.type !== 'purchase')
    .reduce((sum, transaction) => sum + Number(transaction.feeAmount || 0), 0));
  const marketplaceFeesCollected = roundAmount(purchases.reduce((sum, purchase) => sum + Number(purchase.marketplaceFeeAmount || 0), 0));
  const royaltiesPaid = roundAmount(purchases.reduce((sum, purchase) => sum + Number(purchase.royaltyAmount || 0), 0));
  const marketplaceVolume = roundAmount(purchases.reduce((sum, purchase) => sum + Number(purchase.grossAmount || 0), 0));
  const ownershipTransfers = (state.featuredVideos || []).reduce((sum, video) => sum + getVideoTransferCount(video), 0);
  const lastMarketActivityAt = purchases.map((purchase) => purchase.purchasedAt).filter(Boolean).sort().at(-1) || null;
  const reputationScores = Array.from(walletAnalytics.values()).map((wallet) => Number(wallet.reputationScore || 0));

  return {
    activeListings: (state.listings || []).filter((listing) => listing.status === 'active').length,
    soldListings: (state.listings || []).filter((listing) => listing.status === 'sold').length,
    marketplaceVolume,
    primarySales: primarySales.length,
    resaleSales: resaleSales.length,
    royaltiesPaid,
    transferFeesCollected,
    marketplaceFeesCollected,
    totalFeeRevenue: roundAmount(transferFeesCollected + marketplaceFeesCollected),
    uniqueCollectors: new Set(purchases.map((purchase) => purchase.buyerAddress).filter(Boolean)).size,
    uniqueCreators: new Set((state.featuredVideos || []).map((video) => video.creatorAddress).filter(Boolean)).size,
    ownershipTransfers,
    averagePrimarySalePrice: primarySales.length ? roundAmount(primarySales.reduce((sum, purchase) => sum + Number(purchase.grossAmount || 0), 0) / primarySales.length) : 0,
    averageResalePrice: resaleSales.length ? roundAmount(resaleSales.reduce((sum, purchase) => sum + Number(purchase.grossAmount || 0), 0) / resaleSales.length) : 0,
    topReputationScore: reputationScores.length ? Math.max(...reputationScores) : 0,
    lastMarketActivityAt,
  };
}

function exportNodeState(state) {
  const walletAnalytics = buildWalletAnalytics(state);
  const metrics = buildNetworkMetrics(state, walletAnalytics);
  const acceptedPeerSigners = getAcceptedSyncPeerSignerMap(state);
  const localPeerAnnouncement = createLocalPeerAnnouncement(state);
  const trustedPeerSigners = (state.trustedPeerSigners || []).map((entry) => ({
    ...entry,
    signerHistory: Array.isArray(entry.signerHistory) ? [...entry.signerHistory] : [],
  }));
  const chainObservations = (state.chainObservations || []).map((entry) => ({
    ...entry,
    observers: (entry.observers || []).map((observer) => ({ ...observer })),
  }));
  const localHeadEndorsement = createLocalHeadEndorsement(state);
  const headEndorsements = [
    ...(state.chainHeadEndorsements || []).map((entry) => ({ ...entry })),
    ...(localHeadEndorsement ? [localHeadEndorsement] : []),
  ];
  const consensusState = state.consensus || {};
  return {
    network: sanitizeNetwork(state.network),
    manifest: state.manifest,
    economics: {
      ...state.economics,
      metrics,
    },
    metrics,
    chain: state.chain,
    featuredVideos: state.featuredVideos,
    rejectedVideos: state.rejectedVideos || [],
    wallets: state.wallets.map((wallet) => ({
      ...sanitizeWallet(wallet),
      validatorProfile: sanitizeValidatorProfile(wallet.validatorProfile),
      metrics: walletAnalytics.get(wallet.address) || null,
      reputationScore: walletAnalytics.get(wallet.address)?.reputationScore || Number(wallet.reputation || 0),
    })),
    pendingVideos: state.pendingVideos,
    transactions: state.transactions,
    peers: state.peers || [],
    peerRegistry: state.peerRegistry || [],
    trustedPeerSigners,
    chainConsensus: {
      protocol: consensusState.protocol || CONSENSUS_PROTOCOL,
      currentEpoch: Number(consensusState.currentEpoch || 1),
      currentRound: Number(consensusState.currentRound || 0),
      lastFinalizedBlockHash: consensusState.lastFinalizedBlockHash || state.chain?.at?.(-1)?.hash || null,
      validatorSetHash: consensusState.validatorSetHash || null,
      validatorRegistry: (consensusState.validatorRegistry || []).map((entry) => sanitizeConsensusRegistryEntry(entry)),
      epochChanges: (consensusState.epochChanges || []).map((entry) => ({ ...entry })),
      evidence: (consensusState.evidence || []).map((entry) => ({ ...entry })),
      slashingEvents: (consensusState.slashingEvents || []).map((entry) => ({ ...entry })),
      peerAnnouncements: [
        ...(consensusState.peerAnnouncements || []).map((entry) => ({ ...entry })),
        ...(localPeerAnnouncement ? [localPeerAnnouncement] : []),
      ].filter((entry, index, list) => (
        verifyPeerAnnouncement(entry) &&
        list.findIndex((candidate) => normalizePeerUrl(candidate.url) === normalizePeerUrl(entry.url)) === index
      )),
      requiredHeadQuorum: getRequiredHeadQuorum(state),
      trustedPeerCount: trustedPeerSigners.filter((entry) => entry.trustStatus === 'trusted').length,
      protocolPeerCount: acceptedPeerSigners.size,
      observations: chainObservations,
      headEndorsements,
    },
    validatorAttestations: (state.validatorAttestations || []).map((entry) => ({ ...entry })),
    moderationCases: (state.moderationCases || []).map((entry) => ({ ...entry })),
    listings: (state.listings || []).map(sanitizeListing),
  };
}

function normalizePeerUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function normalizeIsoDate(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function resolvePeerAnnouncementExpiry(entry = {}) {
  const observedAt = normalizeIsoDate(entry.observedAt);
  const ttlMs = Math.max(1_000, Number(entry.ttlMs || PEER_ANNOUNCEMENT_TTL_MS));
  if (!observedAt) {
    return { observedAt: null, ttlMs, expiresAt: null };
  }

  const explicitExpiry = normalizeIsoDate(entry.expiresAt);
  const calculatedExpiry = new Date(new Date(observedAt).getTime() + ttlMs).toISOString();
  return {
    observedAt,
    ttlMs,
    expiresAt: explicitExpiry || calculatedExpiry,
  };
}

function isPeerAnnouncementFresh(entry = {}, now = Date.now()) {
  const { expiresAt } = resolvePeerAnnouncementExpiry(entry);
  if (!expiresAt) {
    return false;
  }
  return new Date(expiresAt).getTime() >= now;
}

function sortUnique(list) {
  return Array.from(new Set(list.filter(Boolean))).sort();
}

function normalizeReasonCode(reasonCode, fallbackText = '') {
  const normalized = String(reasonCode || '').trim().toLowerCase();
  if (MODERATION_REASON_CODES.has(normalized)) {
    return normalized;
  }

  const reason = String(fallbackText || '').trim().toLowerCase();
  if (reason.includes('copyright') || reason.includes('duplicate') || reason.includes('pirat')) {
    return 'copyright-duplicate';
  }
  if (reason.includes('sexual') || reason.includes('nsfw') || reason.includes('explicit')) {
    return 'explicit-sexual-content';
  }
  if (reason.includes('violence') || reason.includes('violent') || reason.includes('gore')) {
    return 'graphic-violence';
  }
  if (reason.includes('fraud') || reason.includes('edit') || reason.includes('manipul')) {
    return 'fraudulent-edit';
  }
  if (reason.includes('identity') || reason.includes('imperson')) {
    return 'identity-misuse';
  }
  return 'policy-other';
}

function createModelEvidenceRefs(riskSignals = [], contentHash = null) {
  return (riskSignals || []).map((signal) => ({
    id: `model-${sha256(`${signal}:${contentHash || 'content'}`).slice(0, 16)}`,
    type: 'risk-signal',
    signal,
    evidenceHash: sha256(stableStringify({ signal, contentHash })),
  }));
}

function createHumanEvidenceRef({ actorAddress, notes, evidenceHash, timestamp = new Date().toISOString() }) {
  const normalizedNotes = String(notes || '').trim();
  const resolvedEvidenceHash = evidenceHash || sha256(stableStringify({
    actorAddress,
    notes: normalizedNotes,
    timestamp,
  }));
  return {
    id: `human-${resolvedEvidenceHash.slice(0, 16)}`,
    actorAddress: actorAddress || null,
    notes: normalizedNotes,
    evidenceHash: resolvedEvidenceHash,
    timestamp,
  };
}

function createModerationVotePayload(vote = {}) {
  return {
    caseId: vote.caseId || null,
    pendingId: vote.pendingId || null,
    validatorAddress: vote.validatorAddress || null,
    decision: vote.decision || null,
    reasonCode: vote.reasonCode || 'policy-other',
    policyVersion: vote.policyVersion || MODERATION_POLICY_VERSION,
    evidenceHash: vote.evidenceHash || null,
    timestamp: vote.timestamp || null,
  };
}

function signModerationVote(vote, validatorPrivateKey) {
  const payload = createModerationVotePayload(vote);
  return {
    ...payload,
    signature: signConsensusPayload(payload, validatorPrivateKey),
  };
}

function createModerationCase({
  caseId = randomUUID(),
  videoProof,
  openedBy,
  openedByName,
  reasonCode,
  reasonText,
  riskSignals,
  contentHash,
  modelEvidenceRefs,
  humanEvidenceRefs,
  bondLocked = 0,
  caseType = 'escalation',
  sourcePendingId = null,
  appealOf = null,
}) {
  return {
    caseId,
    videoProof,
    openedAt: new Date().toISOString(),
    openedBy,
    openedByName: openedByName || openedBy || 'system',
    policyVersion: MODERATION_POLICY_VERSION,
    reasonCode: normalizeReasonCode(reasonCode, reasonText),
    reasonText: String(reasonText || '').trim(),
    riskSignals: sortUnique(riskSignals || []),
    modelEvidenceRefs: modelEvidenceRefs || createModelEvidenceRefs(riskSignals, contentHash),
    humanEvidenceRefs: humanEvidenceRefs || [],
    bondLocked: roundAmount(Number(bondLocked || 0)),
    status: caseType === 'appeal' ? 'appeal-open' : 'open',
    caseType,
    sourcePendingId,
    appealOf,
    appealsCount: caseType === 'appeal' ? 1 : 0,
    appealHistory: [],
    validatorVotes: [],
    finalDecision: null,
    closedAt: null,
    resolutionSummary: null,
  };
}

function getModerationCaseById(state, caseId) {
  return (state.moderationCases || []).find((entry) => entry.caseId === caseId) || null;
}

function getLatestModerationCaseForProof(state, videoProof) {
  return (state.moderationCases || []).find((entry) => entry.videoProof === videoProof) || null;
}

function upsertModerationCase(state, moderationCase) {
  const next = [...(state.moderationCases || [])];
  const index = next.findIndex((entry) => entry.caseId === moderationCase.caseId);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...moderationCase,
    };
  } else {
    next.unshift(moderationCase);
  }
  state.moderationCases = next
    .sort((left, right) => new Date(right.openedAt || 0) - new Date(left.openedAt || 0))
    .slice(0, CONSENSUS_EVIDENCE_LIMIT);
  return getModerationCaseById(state, moderationCase.caseId);
}

function getConsensusPrivateKey(wallet) {
  return wallet?.consensusPrivateKey || wallet?.privateKey || null;
}

function getConsensusPublicKey(wallet) {
  return wallet?.consensusPublicKey || wallet?.publicKey || null;
}

function computeValidatorSetHash(registry = []) {
  return sha256(stableStringify(
    registry.map((entry) => ({
      validatorAddress: entry.validatorAddress,
      consensusPublicKey: entry.consensusPublicKey,
      votingPower: Number(entry.votingPower || 0),
      stake: roundAmount(Number(entry.stake || 0)),
      status: entry.status || 'inactive',
      source: entry.source || 'wallet',
    }))
  ));
}

function computeQuorumThreshold(registry = []) {
  const totalVotingPower = registry.reduce((sum, entry) => sum + Math.max(0, Number(entry.votingPower || 0)), 0);
  if (totalVotingPower <= 1) {
    return Math.max(1, totalVotingPower);
  }
  return Math.floor((2 * totalVotingPower) / 3) + 1;
}

function getConsensusRegistry(state) {
  return (state.consensus?.validatorRegistry || []).map((entry) => sanitizeConsensusRegistryEntry(entry));
}

function getConsensusValidatorSnapshot(state) {
  const registry = getConsensusRegistry(state).filter((entry) => {
    if (!(entry.status === 'active' && entry.consensusPublicKey && entry.votingPower > 0)) {
      return false;
    }
    const wallet = getWalletByAddress(state, entry.validatorAddress);
    return Boolean(wallet && getConsensusPrivateKey(wallet));
  });
  if (registry.length > 0) {
    return registry;
  }

  const nodeSigner = getNodeSigner(state);
  if (!nodeSigner?.publicKey) {
    return [];
  }

  return [sanitizeConsensusRegistryEntry({
    validatorAddress: BOOTSTRAP_VALIDATOR_ADDRESS,
    validatorName: 'bootstrap-node-signer',
    consensusPublicKey: nodeSigner.publicKey,
    stake: 0,
    votingPower: 1,
    status: 'active',
    joinedAt: state.network?.createdAt || null,
    activatedAt: state.network?.createdAt || null,
    source: 'bootstrap',
  })];
}

function appendConsensusEvidence(state, evidence = {}) {
  if (!state.consensus) {
    state.consensus = {};
  }

  const nextEvidence = {
    id: evidence.id || randomUUID(),
    type: evidence.type || 'consensus-evidence',
    validatorAddress: evidence.validatorAddress || null,
    offender: evidence.offender || evidence.validatorAddress || null,
    blockHash: evidence.blockHash || null,
    height: Number.isInteger(evidence.height) ? evidence.height : Number(evidence.height || 0),
    round: Number.isInteger(evidence.round) ? evidence.round : Number(evidence.round || 0),
    epoch: Number.isInteger(evidence.epoch) ? evidence.epoch : Number(evidence.epoch || 0),
    phase: evidence.phase || null,
    details: evidence.details || null,
    recordedAt: evidence.recordedAt || new Date().toISOString(),
    slashed: Boolean(evidence.slashed),
  };

  const existing = (state.consensus.evidence || []).find((entry) => (
    entry.type === nextEvidence.type &&
    entry.validatorAddress === nextEvidence.validatorAddress &&
    entry.blockHash === nextEvidence.blockHash &&
    Number(entry.height || 0) === nextEvidence.height &&
    Number(entry.round || 0) === nextEvidence.round &&
    Number(entry.epoch || 0) === nextEvidence.epoch &&
    entry.phase === nextEvidence.phase
  ));
  if (existing) {
    return existing;
  }

  state.consensus.evidence = [nextEvidence, ...(state.consensus.evidence || [])].slice(0, CONSENSUS_EVIDENCE_LIMIT);
  return nextEvidence;
}

function recordSlashingEvent(state, wallet, amount, reason, evidence) {
  if (!state.consensus) {
    state.consensus = {};
  }
  state.consensus.slashingEvents = [{
    id: randomUUID(),
    validatorAddress: wallet?.address || null,
    validatorName: wallet?.username || wallet?.address || 'unknown-validator',
    amount: roundAmount(Number(amount || 0)),
    reason,
    evidenceId: evidence?.id || null,
    blockHash: evidence?.blockHash || null,
    recordedAt: new Date().toISOString(),
  }, ...(state.consensus.slashingEvents || [])].slice(0, CONSENSUS_EVIDENCE_LIMIT);
}

function ensureConsensusState(state) {
  if (!state.consensus) {
    state.consensus = {};
  }
  state.consensus.protocol = state.consensus.protocol || CONSENSUS_PROTOCOL;
  state.consensus.currentEpoch = Number(state.consensus.currentEpoch || 1);
  state.consensus.currentRound = Number(state.consensus.currentRound || 0);
  state.consensus.validatorRegistry = Array.isArray(state.consensus.validatorRegistry)
    ? state.consensus.validatorRegistry.map((entry) => sanitizeConsensusRegistryEntry(entry))
    : [];
  state.consensus.validatorSetHash = state.consensus.validatorSetHash || computeValidatorSetHash(state.consensus.validatorRegistry);
  state.consensus.epochChanges = Array.isArray(state.consensus.epochChanges) ? state.consensus.epochChanges : [];
  state.consensus.evidence = Array.isArray(state.consensus.evidence) ? state.consensus.evidence : [];
  state.consensus.voteJournal = Array.isArray(state.consensus.voteJournal) ? state.consensus.voteJournal : [];
  state.consensus.slashingEvents = Array.isArray(state.consensus.slashingEvents) ? state.consensus.slashingEvents : [];
  state.consensus.peerAnnouncements = Array.isArray(state.consensus.peerAnnouncements) ? state.consensus.peerAnnouncements : [];
  state.consensus.lastFinalizedBlockHash = state.consensus.lastFinalizedBlockHash || state.chain?.at?.(-1)?.hash || null;
  return state.consensus;
}

function syncConsensusValidatorRegistry(state) {
  const consensus = ensureConsensusState(state);
  const previousRegistry = getConsensusRegistry(state);
  const previousHash = consensus.validatorSetHash || computeValidatorSetHash(previousRegistry);
  const strictMode = getActiveValidatorCount(state) >= VALIDATION_TARGET;
  const walletRegistry = (state.wallets || [])
    .filter((wallet) => getConsensusPublicKey(wallet))
    .map((wallet) => {
      const profile = recomputeValidatorProfile(state, wallet);
      const status = canParticipateAsValidator(state, wallet)
        ? 'active'
        : (strictMode ? (profile.status || 'candidate') : (hasValidatorBond(wallet) ? 'bonded' : (profile.status || 'inactive')));
      return sanitizeConsensusRegistryEntry({
        validatorAddress: wallet.address,
        validatorName: wallet.username,
        consensusPublicKey: getConsensusPublicKey(wallet),
        stake: getWalletStakeBalance(wallet),
        votingPower: status === 'active' ? Math.max(1, Math.floor(getWalletStakeBalance(wallet) || 1)) : 0,
        status,
        joinedAt: wallet.createdAt || null,
        activatedAt: profile.activatedAt || null,
        source: 'wallet',
      });
    })
    .sort((left, right) => left.validatorAddress.localeCompare(right.validatorAddress));

  consensus.validatorRegistry = walletRegistry;
  consensus.validatorSetHash = computeValidatorSetHash(walletRegistry);

  if (previousHash !== consensus.validatorSetHash) {
    const previousEpoch = Number(consensus.currentEpoch || 1);
    consensus.currentEpoch = previousRegistry.length === 0 ? previousEpoch : previousEpoch + 1;
    consensus.epochChanges = [{
      id: randomUUID(),
      epoch: consensus.currentEpoch,
      previousValidatorSetHash: previousHash || null,
      nextValidatorSetHash: consensus.validatorSetHash,
      activatedAt: new Date().toISOString(),
      validatorAddresses: walletRegistry.map((entry) => entry.validatorAddress),
    }, ...(consensus.epochChanges || [])].slice(0, CONSENSUS_EVIDENCE_LIMIT);
  }

  return consensus;
}

function signConsensusVote(validator, votePayload, timestamp = new Date().toISOString()) {
  const signature = signConsensusPayload(votePayload, validator.privateKey);
  return {
    ...votePayload,
    timestamp,
    signature,
  };
}

function recordConsensusVote(state, vote) {
  const consensus = ensureConsensusState(state);
  const normalizedVote = {
    ...vote,
    height: Number(vote.height || 0),
    round: Number(vote.round || 0),
    epoch: Number(vote.epoch || 0),
  };
  const duplicate = (consensus.voteJournal || []).find((entry) => (
    entry.validatorAddress === normalizedVote.validatorAddress &&
    entry.phase === normalizedVote.phase &&
    Number(entry.height || 0) === normalizedVote.height &&
    Number(entry.round || 0) === normalizedVote.round &&
    Number(entry.epoch || 0) === normalizedVote.epoch &&
    entry.blockHash !== normalizedVote.blockHash
  ));

  if (duplicate) {
    const evidenceType = normalizedVote.phase === 'precommit'
      ? 'duplicatePrecommitEvidence'
      : 'duplicatePrevoteEvidence';
    const evidence = appendConsensusEvidence(state, {
      type: evidenceType,
      validatorAddress: normalizedVote.validatorAddress,
      blockHash: normalizedVote.blockHash,
      height: normalizedVote.height,
      round: normalizedVote.round,
      epoch: normalizedVote.epoch,
      phase: normalizedVote.phase,
      details: {
        firstBlockHash: duplicate.blockHash,
        conflictingBlockHash: normalizedVote.blockHash,
      },
      slashed: true,
    });
    const wallet = getWalletByAddress(state, normalizedVote.validatorAddress);
    if (wallet) {
      const slashAmount = slashValidatorStake(state, wallet, VALIDATOR_SLASH);
      recordSlashingEvent(state, wallet, slashAmount, evidenceType, evidence);
    }
    return false;
  }

  consensus.voteJournal = [normalizedVote, ...(consensus.voteJournal || [])].slice(0, CONSENSUS_VOTE_JOURNAL_LIMIT);
  return true;
}

function createConsensusCertificate(phase, block, validatorSnapshot, votes, previousCertificate = null) {
  return {
    phase,
    protocol: CONSENSUS_PROTOCOL,
    blockHash: block.hash,
    height: block.height,
    round: block.round,
    epoch: block.epoch,
    validatorSetHash: block.validatorSetHash,
    quorumThreshold: computeQuorumThreshold(validatorSnapshot),
    totalValidators: validatorSnapshot.length,
    validatorSnapshot,
    votes,
    previousCertificate,
    certifiedAt: new Date().toISOString(),
  };
}

function createConsensusFinality(block, validatorSnapshot) {
  const voteTimestamp = new Date().toISOString();
  const validators = validatorSnapshot.map((entry) => {
    if (entry.validatorAddress === BOOTSTRAP_VALIDATOR_ADDRESS) {
      const nodeSigner = {
        address: BOOTSTRAP_VALIDATOR_ADDRESS,
        username: entry.validatorName,
        publicKey: entry.consensusPublicKey,
        privateKey: getNodeSigner(block.__state).privateKey,
      };
      return nodeSigner;
    }

    const wallet = getWalletByAddress(block.__state, entry.validatorAddress);
    if (!wallet || !getConsensusPrivateKey(wallet) || !getConsensusPublicKey(wallet)) {
      return null;
    }
    return {
      address: wallet.address,
      username: wallet.username,
      publicKey: getConsensusPublicKey(wallet),
      privateKey: getConsensusPrivateKey(wallet),
    };
  }).filter(Boolean);

  const prevoteVotes = validators.map((validator) => {
    const payload = createConsensusVotePayload({
      phase: 'prevote',
      blockHash: block.hash,
      height: block.height,
      round: block.round,
      epoch: block.epoch,
      validatorSetHash: block.validatorSetHash,
      validatorAddress: validator.address,
      validatorPublicKey: validator.publicKey,
    });
    return signConsensusVote(validator, payload, voteTimestamp);
  });

  for (const vote of prevoteVotes) {
    recordConsensusVote(block.__state, vote);
  }

  const proposalCertificate = createConsensusCertificate('prevote', block, validatorSnapshot, prevoteVotes);
  const precommitVotes = validators.map((validator) => {
    const payload = createConsensusVotePayload({
      phase: 'precommit',
      blockHash: block.hash,
      height: block.height,
      round: block.round,
      epoch: block.epoch,
      validatorSetHash: block.validatorSetHash,
      validatorAddress: validator.address,
      validatorPublicKey: validator.publicKey,
    });
    return signConsensusVote(validator, payload, voteTimestamp);
  });

  for (const vote of precommitVotes) {
    recordConsensusVote(block.__state, vote);
  }

  return {
    proposalCertificate,
    quorumCertificate: createConsensusCertificate('precommit', block, validatorSnapshot, precommitVotes, proposalCertificate),
    consensusLifecycle: {
      proposedAt: block.timestamp,
      certifiedAt: voteTimestamp,
      finalizedAt: voteTimestamp,
    },
    finalityStatus: 'finalized',
  };
}

function getBlockValidatorSnapshot(block) {
  return (block?.quorumCertificate?.validatorSnapshot || []).map((entry) => sanitizeConsensusRegistryEntry(entry));
}

function getConsensusPublicKeyForVote(block, vote, walletIndex = new Map(), nodeSignerPublicKey = null) {
  if (vote?.validatorPublicKey) {
    return vote.validatorPublicKey;
  }
  if (vote?.validatorAddress === BOOTSTRAP_VALIDATOR_ADDRESS) {
    return nodeSignerPublicKey;
  }

  const snapshotEntry = getBlockValidatorSnapshot(block).find((entry) => entry.validatorAddress === vote?.validatorAddress);
  if (snapshotEntry?.consensusPublicKey) {
    return snapshotEntry.consensusPublicKey;
  }

  return walletIndex.get(vote?.validatorAddress)?.publicKey || null;
}

function verifyConsensusCertificate(block, certificate, walletIndex = new Map(), nodeSignerPublicKey = null) {
  if (!certificate?.blockHash || certificate.blockHash !== block.hash) {
    return false;
  }
  if (certificate.height !== block.height || certificate.round !== block.round || certificate.epoch !== block.epoch) {
    return false;
  }
  const validatorSnapshot = (certificate.validatorSnapshot || []).map((entry) => sanitizeConsensusRegistryEntry(entry));
  if (computeValidatorSetHash(validatorSnapshot) !== block.validatorSetHash || certificate.validatorSetHash !== block.validatorSetHash) {
    return false;
  }

  const quorumThreshold = computeQuorumThreshold(validatorSnapshot);
  if (Number(certificate.quorumThreshold || 0) !== quorumThreshold) {
    return false;
  }

  const uniqueVotes = new Set();
  let accumulatedVotingPower = 0;
  for (const vote of certificate.votes || []) {
    const payload = createConsensusVotePayload(vote);
    if (
      payload.phase !== certificate.phase ||
      payload.blockHash !== block.hash ||
      payload.height !== block.height ||
      payload.round !== block.round ||
      payload.epoch !== block.epoch ||
      payload.validatorSetHash !== block.validatorSetHash
    ) {
      return false;
    }
    if (uniqueVotes.has(payload.validatorAddress)) {
      return false;
    }
    const publicKey = getConsensusPublicKeyForVote(block, vote, walletIndex, nodeSignerPublicKey);
    if (!verifyConsensusSignature(payload, publicKey, vote.signature)) {
      return false;
    }
    uniqueVotes.add(payload.validatorAddress);
    accumulatedVotingPower += Math.max(0, Number(validatorSnapshot.find((entry) => entry.validatorAddress === payload.validatorAddress)?.votingPower || 0));
  }

  return accumulatedVotingPower >= quorumThreshold;
}

function validateFormalBlock(block, previousBlock, options = {}) {
  if (!block || !Number.isInteger(block.height) || !Number.isInteger(block.round) || !Number.isInteger(block.epoch)) {
    return false;
  }
  const expectedHeight = previousBlock ? previousBlock.height + 1 : 0;
  if (block.height !== expectedHeight) {
    return false;
  }
  const expectedParentHash = previousBlock?.hash ?? null;
  if ((block.parentHash ?? null) !== expectedParentHash) {
    return false;
  }
  if ((block.prevHash ?? null) !== expectedParentHash) {
    return false;
  }
  if (!block.proposer || !block.validatorSetHash || !block.quorumCertificate || block.finalityStatus !== 'finalized') {
    return false;
  }

  const walletIndex = options.walletIndex || new Map();
  const nodeSignerPublicKey = options.nodeSignerPublicKey || null;
  if (!verifyConsensusCertificate(block, block.proposalCertificate, walletIndex, nodeSignerPublicKey)) {
    return false;
  }
  if (!verifyConsensusCertificate(block, block.quorumCertificate, walletIndex, nodeSignerPublicKey)) {
    return false;
  }
  return true;
}

function validateConsensusStateView(remoteState) {
  const walletIndex = new Map((remoteState.wallets || []).map((wallet) => [wallet.address, wallet]));
  for (let index = 0; index < (remoteState.chain || []).length; index += 1) {
    const block = remoteState.chain[index];
    const previous = index > 0 ? remoteState.chain[index - 1] : null;
    if (!validateFormalBlock(block, previous, {
      walletIndex,
      nodeSignerPublicKey: remoteState.network?.nodeSignerPublicKey || null,
    })) {
      return false;
    }
  }
  return true;
}

function upsertPeerRegistryEntry(entries = [], incoming) {
  const freshnessTimestamp = normalizeIsoDate(
    incoming.lastValidatedAt ||
    incoming.lastSyncedAt ||
    incoming.lastCheckedAt ||
    incoming.observedAt ||
    incoming.lastFreshAt
  );
  const normalizedIncoming = {
    ...incoming,
    lastFreshAt: freshnessTimestamp,
    freshnessTtlMs: Number(incoming.freshnessTtlMs || PEER_ANNOUNCEMENT_TTL_MS),
    peerScore: Number.isFinite(Number(incoming.peerScore))
      ? Number(incoming.peerScore)
      : (
        incoming.syncStatus === 'synchronized' ? 100
          : incoming.syncStatus === 'protocol-verified' ? 90
            : incoming.syncStatus === 'rotation-pending' ? 60
              : incoming.linkStatus === 'linked' ? 40
                : 10
      ),
  };
  const next = [...entries];
  const index = next.findIndex((entry) => entry.url === normalizedIncoming.url);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...normalizedIncoming,
    };
    return next;
  }
  next.push(normalizedIncoming);
  return next.sort((left, right) => left.url.localeCompare(right.url));
}

function getWalletStakeBalance(wallet) {
  return roundAmount(Number(wallet?.stakeBalance || 0));
}

function hasValidatorBond(wallet) {
  return getWalletStakeBalance(wallet) >= MIN_VALIDATOR_STAKE;
}

function getValidatorProfile(wallet) {
  if (!wallet) {
    return sanitizeValidatorProfile(null);
  }

  if (!wallet.validatorProfile) {
    wallet.validatorProfile = sanitizeValidatorProfile({
      humanIdentityCommitment: wallet.humanIdentityCommitment || null,
      status: 'provisional',
    });
  } else {
    wallet.validatorProfile = sanitizeValidatorProfile(wallet.validatorProfile);
  }

  return wallet.validatorProfile;
}

function hasUniqueHumanCommitment(state, wallet) {
  const profile = getValidatorProfile(wallet);
  if (!profile.humanIdentityCommitment) {
    return false;
  }

  return !(state.wallets || []).some((candidate) => (
    candidate.address !== wallet.address &&
    getValidatorProfile(candidate).humanIdentityCommitment &&
    getValidatorProfile(candidate).humanIdentityCommitment === profile.humanIdentityCommitment
  ));
}

function getIndependentAttestors(state, wallet) {
  const profile = getValidatorProfile(wallet);
  const attestors = sortUnique(profile.attestedBy || []);
  const candidateCommitment = profile.humanIdentityCommitment || null;

  return attestors.filter((address, index, list) => {
    const attestor = getWalletByAddress(state, address);
    if (!attestor) {
      return false;
    }
    const attestorProfile = getValidatorProfile(attestor);
    if (!attestorProfile.humanIdentityCommitment) {
      return false;
    }
    if (attestorProfile.humanIdentityCommitment === candidateCommitment) {
      return false;
    }
    return list.findIndex((otherAddress) => {
      const otherWallet = getWalletByAddress(state, otherAddress);
      return getValidatorProfile(otherWallet).humanIdentityCommitment === attestorProfile.humanIdentityCommitment;
    }) === index;
  });
}

function getActiveValidatorCount(state) {
  return (state.wallets || []).filter((wallet) => getValidatorProfile(wallet).status === 'active').length;
}

function recomputeValidatorProfile(state, wallet) {
  if (!wallet) {
    return sanitizeValidatorProfile(null);
  }

  const profile = getValidatorProfile(wallet);
  const independentAttestors = getIndependentAttestors(state, wallet);
  const uniquenessViolations = hasUniqueHumanCommitment(state, wallet) ? 0 : 1;
  const antiSybilScore = roundAmount(Math.max(
    0,
    independentAttestors.length - uniquenessViolations
  ));
  const shouldBeActive = (
    hasValidatorBond(wallet) &&
    Boolean(profile.humanIdentityCommitment) &&
    uniquenessViolations === 0 &&
    independentAttestors.length >= MIN_PERSONHOOD_ATTESTATIONS
  );

  wallet.validatorProfile = sanitizeValidatorProfile({
    ...profile,
    attestedBy: independentAttestors,
    attestationsCount: independentAttestors.length,
    uniquenessViolations,
    antiSybilScore,
    status: shouldBeActive ? 'active' : (profile.humanIdentityCommitment ? 'candidate' : 'provisional'),
    activatedAt: shouldBeActive ? (profile.activatedAt || new Date().toISOString()) : null,
  });

  return wallet.validatorProfile;
}

function canParticipateAsValidator(state, wallet) {
  if (!wallet || !hasValidatorBond(wallet)) {
    return false;
  }

  const profile = recomputeValidatorProfile(state, wallet);
  const strictMode = getActiveValidatorCount(state) >= VALIDATION_TARGET;
  if (!strictMode) {
    return true;
  }

  return profile.status === 'active';
}

function normalizeTrustedSignerEntry(entry = {}) {
  return {
    url: normalizePeerUrl(entry.url),
    signerPublicKey: entry.signerPublicKey || null,
    signerHistory: Array.isArray(entry.signerHistory)
      ? sortUnique(entry.signerHistory)
      : sortUnique([entry.signerPublicKey].filter(Boolean)),
    pendingSignerPublicKey: entry.pendingSignerPublicKey || null,
    revokedSignerPublicKeys: Array.isArray(entry.revokedSignerPublicKeys)
      ? sortUnique(entry.revokedSignerPublicKeys)
      : [],
    trustStatus: entry.trustStatus || 'trusted',
    firstTrustedAt: entry.firstTrustedAt || null,
    lastValidatedAt: entry.lastValidatedAt || null,
    lastRotationDetectedAt: entry.lastRotationDetectedAt || null,
    revokedAt: entry.revokedAt || null,
    revocationReason: entry.revocationReason || null,
  };
}

function upsertTrustedPeerSigner(entries = [], incoming) {
  const normalized = normalizeTrustedSignerEntry(incoming);
  const next = [...entries];
  const index = next.findIndex((entry) => normalizePeerUrl(entry.url) === normalized.url);
  if (index >= 0) {
    next[index] = normalizeTrustedSignerEntry({
      ...next[index],
      ...normalized,
      signerHistory: sortUnique([
        ...(next[index].signerHistory || []),
        ...(normalized.signerHistory || []),
        normalized.signerPublicKey,
      ].filter(Boolean)),
      revokedSignerPublicKeys: sortUnique([
        ...(next[index].revokedSignerPublicKeys || []),
        ...(normalized.revokedSignerPublicKeys || []),
      ].filter(Boolean)),
    });
    return next.sort((left, right) => left.url.localeCompare(right.url));
  }

  next.push(normalized);
  return next.sort((left, right) => left.url.localeCompare(right.url));
}

function getTrustedPeerSignerEntry(state, url) {
  const peerUrl = normalizePeerUrl(url);
  if (!peerUrl) {
    return null;
  }

  return (state.trustedPeerSigners || []).find((entry) => normalizePeerUrl(entry.url) === peerUrl) || null;
}

function recordTrustedPeerSigner(state, { url, signerPublicKey, checkedAt = new Date().toISOString() }) {
  const peerUrl = normalizePeerUrl(url);
  if (!peerUrl || !signerPublicKey) {
    return { updatedState: state, entry: null, rotationDetected: false };
  }

  const existing = getTrustedPeerSignerEntry(state, peerUrl);
  if (!existing) {
    state.trustedPeerSigners = upsertTrustedPeerSigner(state.trustedPeerSigners, {
      url: peerUrl,
      signerPublicKey,
      signerHistory: [signerPublicKey],
      pendingSignerPublicKey: null,
      revokedSignerPublicKeys: [],
      trustStatus: 'trusted',
      firstTrustedAt: checkedAt,
      lastValidatedAt: checkedAt,
      lastRotationDetectedAt: null,
      revokedAt: null,
      revocationReason: null,
    });
    return {
      updatedState: state,
      entry: getTrustedPeerSignerEntry(state, peerUrl),
      rotationDetected: false,
    };
  }

  if (existing.trustStatus === 'revoked') {
    return {
      updatedState: state,
      entry: existing,
      rotationDetected: false,
      revoked: true,
    };
  }

  if ((existing.revokedSignerPublicKeys || []).includes(signerPublicKey)) {
    return {
      updatedState: state,
      entry: existing,
      rotationDetected: false,
      revoked: true,
    };
  }

  if (existing.signerPublicKey === signerPublicKey) {
    state.trustedPeerSigners = upsertTrustedPeerSigner(state.trustedPeerSigners, {
      ...existing,
      lastValidatedAt: checkedAt,
      pendingSignerPublicKey: null,
      trustStatus: 'trusted',
      revokedAt: null,
      revocationReason: null,
    });
    return {
      updatedState: state,
      entry: getTrustedPeerSignerEntry(state, peerUrl),
      rotationDetected: false,
    };
  }

  state.trustedPeerSigners = upsertTrustedPeerSigner(state.trustedPeerSigners, {
    ...existing,
    pendingSignerPublicKey: signerPublicKey,
    trustStatus: 'rotation-pending',
    lastRotationDetectedAt: checkedAt,
    lastValidatedAt: existing.lastValidatedAt || checkedAt,
  });

  return {
    updatedState: state,
    entry: getTrustedPeerSignerEntry(state, peerUrl),
    rotationDetected: true,
  };
}


function revokeTrustedPeer(state, { url, reason, revokedAt = new Date().toISOString() }) {
  const peerUrl = normalizePeerUrl(url);
  if (!peerUrl) {
    throw new Error('Debes indicar la URL del peer.');
  }

  const existing = getTrustedPeerSignerEntry(state, peerUrl);
  const revokedKeys = sortUnique([
    existing?.signerPublicKey,
    existing?.pendingSignerPublicKey,
    ...(existing?.revokedSignerPublicKeys || []),
  ].filter(Boolean));

  state.trustedPeerSigners = upsertTrustedPeerSigner(state.trustedPeerSigners, {
    ...existing,
    url: peerUrl,
    pendingSignerPublicKey: null,
    revokedSignerPublicKeys: revokedKeys,
    trustStatus: 'revoked',
    revokedAt,
    revocationReason: reason || 'Peer revoked by operator.',
    lastValidatedAt: revokedAt,
  });

  state.peers = (state.peers || []).filter((entry) => normalizePeerUrl(entry) !== peerUrl);
  state.peerRegistry = upsertPeerRegistryEntry(state.peerRegistry, {
    url: peerUrl,
    linkStatus: 'revoked',
    syncStatus: 'revoked',
    syncCapable: false,
    lastCheckedAt: revokedAt,
    note: reason || 'Peer revoked by operator.',
  });

  return {
    peerConnection: state.peerRegistry.find((entry) => normalizePeerUrl(entry.url) === peerUrl) || null,
    trustedSigner: getTrustedPeerSignerEntry(state, peerUrl),
  };
}

function normalizeChainObservationEntry(entry = {}) {
  return {
    headHash: entry.headHash || null,
    observedAt: entry.observedAt || null,
    observers: (entry.observers || []).map((observer) => ({
      url: normalizePeerUrl(observer.url),
      signerPublicKey: observer.signerPublicKey || null,
      observedAt: observer.observedAt || entry.observedAt || null,
      source: observer.source || 'remote-export',
    })).filter((observer) => observer.url && observer.signerPublicKey),
  };
}

function recordChainObservation(state, { url, signerPublicKey, headHash, observedAt = new Date().toISOString(), source = 'remote-export' }) {
  const peerUrl = normalizePeerUrl(url);
  if (!peerUrl || !signerPublicKey || !headHash) {
    return;
  }

  const next = [...(state.chainObservations || [])];
  const index = next.findIndex((entry) => entry.headHash === headHash);
  const observer = { url: peerUrl, signerPublicKey, observedAt, source };

  if (index >= 0) {
    const observers = [...(next[index].observers || [])];
    const observerIndex = observers.findIndex((item) => item.url === peerUrl);
    if (observerIndex >= 0) {
      observers[observerIndex] = {
        ...observers[observerIndex],
        ...observer,
      };
    } else {
      observers.push(observer);
    }
    next[index] = normalizeChainObservationEntry({
      ...next[index],
      observedAt: observedAt > (next[index].observedAt || '') ? observedAt : next[index].observedAt,
      observers,
    });
  } else {
    next.push(normalizeChainObservationEntry({
      headHash,
      observedAt,
      observers: [observer],
    }));
  }

  state.chainObservations = next
    .filter((entry) => entry.headHash)
    .sort((left, right) => new Date(right.observedAt || 0) - new Date(left.observedAt || 0))
    .slice(0, 64);
}

function mergeChainObservations(state, incomingObservations = []) {
  for (const entry of incomingObservations) {
    for (const observer of entry.observers || []) {
      recordChainObservation(state, {
        url: observer.url,
        signerPublicKey: observer.signerPublicKey,
        headHash: entry.headHash,
        observedAt: observer.observedAt || entry.observedAt || new Date().toISOString(),
        source: observer.source || 'peer-consensus',
      });
    }
  }
}

function createHeadEndorsementSignaturePayload(endorsement) {
  return {
    headHash: endorsement.headHash,
    nodeUrl: normalizePeerUrl(endorsement.nodeUrl),
    signerPublicKey: endorsement.signerPublicKey || null,
    observedAt: endorsement.observedAt || null,
  };
}

function normalizeHeadEndorsement(entry = {}) {
  return {
    headHash: entry.headHash || null,
    nodeUrl: normalizePeerUrl(entry.nodeUrl),
    signerPublicKey: entry.signerPublicKey || null,
    observedAt: entry.observedAt || null,
    signature: entry.signature || null,
    source: entry.source || 'self-signed-head',
  };
}

function verifyHeadEndorsement(entry) {
  const endorsement = normalizeHeadEndorsement(entry);
  return Boolean(
    endorsement.headHash &&
    endorsement.nodeUrl &&
    endorsement.signerPublicKey &&
    endorsement.signature &&
    verifyConsensusSignature(
      createHeadEndorsementSignaturePayload(endorsement),
      endorsement.signerPublicKey,
      endorsement.signature
    )
  );
}

function createPeerAnnouncementSignaturePayload(entry) {
  const freshness = resolvePeerAnnouncementExpiry(entry);
  return {
    url: normalizePeerUrl(entry.url),
    signerPublicKey: entry.signerPublicKey || null,
    epoch: Number(entry.epoch || 0),
    observedAt: freshness.observedAt,
    ttlMs: freshness.ttlMs,
    expiresAt: freshness.expiresAt,
    validatorSetHash: entry.validatorSetHash || null,
    headHash: entry.headHash || null,
  };
}

function normalizePeerAnnouncement(entry = {}) {
  const freshness = resolvePeerAnnouncementExpiry(entry);
  return {
    url: normalizePeerUrl(entry.url),
    signerPublicKey: entry.signerPublicKey || null,
    epoch: Number(entry.epoch || 0),
    observedAt: freshness.observedAt,
    ttlMs: freshness.ttlMs,
    expiresAt: freshness.expiresAt,
    validatorSetHash: entry.validatorSetHash || null,
    headHash: entry.headHash || null,
    signature: entry.signature || null,
    source: entry.source || 'peer-announcement',
  };
}

function verifyPeerAnnouncement(entry) {
  const announcement = normalizePeerAnnouncement(entry);
  return Boolean(
    announcement.url &&
    announcement.signerPublicKey &&
    announcement.epoch > 0 &&
    announcement.observedAt &&
    announcement.expiresAt &&
    announcement.signature &&
    isPeerAnnouncementFresh(announcement) &&
    verifyConsensusSignature(
      createPeerAnnouncementSignaturePayload(announcement),
      announcement.signerPublicKey,
      announcement.signature
    )
  );
}

function createLocalPeerAnnouncement(state) {
  const nodeUrl = normalizePeerUrl(state.network?.publicUrl);
  const nodeSigner = getNodeSigner(state);
  if (!nodeUrl || !nodeSigner?.publicKey || !nodeSigner?.privateKey) {
    return null;
  }

  const announcement = normalizePeerAnnouncement({
    url: nodeUrl,
    signerPublicKey: nodeSigner.publicKey,
    epoch: Number(state.consensus?.currentEpoch || 1),
    observedAt: new Date().toISOString(),
    ttlMs: PEER_ANNOUNCEMENT_TTL_MS,
    validatorSetHash: state.consensus?.validatorSetHash || null,
    headHash: state.chain?.at?.(-1)?.hash || null,
    source: 'self-announced-peer',
  });
  announcement.signature = signConsensusPayload(
    createPeerAnnouncementSignaturePayload(announcement),
    nodeSigner.privateKey
  );
  return announcement;
}

function mergePeerAnnouncements(state, incoming = []) {
  const next = [...(state.consensus?.peerAnnouncements || [])];

  for (const entry of incoming) {
    const announcement = normalizePeerAnnouncement(entry);
    if (!verifyPeerAnnouncement(announcement)) {
      continue;
    }

    const index = next.findIndex((item) => normalizePeerUrl(item.url) === announcement.url);
    if (index >= 0) {
      next[index] = {
        ...next[index],
        ...announcement,
      };
    } else {
      next.push(announcement);
    }
  }

  state.consensus.peerAnnouncements = next
    .filter((entry) => verifyPeerAnnouncement(entry) && isPeerAnnouncementFresh(entry))
    .sort((left, right) => new Date(right.observedAt || 0) - new Date(left.observedAt || 0))
    .slice(0, PEER_ANNOUNCEMENT_LIMIT);
}

function createLocalHeadEndorsement(state) {
  const headHash = state.chain?.at?.(-1)?.hash || null;
  const nodeSigner = getNodeSigner(state);
  const nodeUrl = normalizePeerUrl(state.network?.publicUrl);
  if (!headHash || !nodeSigner?.privateKey || !nodeSigner?.publicKey || !nodeUrl) {
    return null;
  }

  const endorsement = normalizeHeadEndorsement({
    headHash,
    nodeUrl,
    signerPublicKey: nodeSigner.publicKey,
    observedAt: new Date().toISOString(),
    source: 'self-signed-head',
  });
  endorsement.signature = signConsensusPayload(
    createHeadEndorsementSignaturePayload(endorsement),
    nodeSigner.privateKey
  );
  return endorsement;
}

function mergeHeadEndorsements(state, incoming = []) {
  const next = [...(state.chainHeadEndorsements || [])];
  for (const entry of incoming) {
    const endorsement = normalizeHeadEndorsement(entry);
    if (!verifyHeadEndorsement(endorsement)) {
      continue;
    }
    const index = next.findIndex((item) => item.headHash === endorsement.headHash && normalizePeerUrl(item.nodeUrl) === endorsement.nodeUrl);
    if (index >= 0) {
      next[index] = {
        ...next[index],
        ...endorsement,
      };
    } else {
      next.push(endorsement);
    }
  }

  state.chainHeadEndorsements = next
    .filter((entry) => verifyHeadEndorsement(entry))
    .sort((left, right) => new Date(right.observedAt || 0) - new Date(left.observedAt || 0))
    .slice(0, 128);
}

function getTrustedObserverCountForHead(state, headHash) {
  const acceptedPeers = getAcceptedSyncPeerSignerMap(state);

  return new Set(
    (state.chainHeadEndorsements || [])
      .filter((endorsement) => (
        endorsement.headHash === headHash &&
        verifyHeadEndorsement(endorsement) &&
        acceptedPeers.get(normalizePeerUrl(endorsement.nodeUrl)) === endorsement.signerPublicKey
      ))
      .map((endorsement) => normalizePeerUrl(endorsement.nodeUrl))
  ).size;
}

function getRequiredHeadQuorum(state) {
  const acceptedSyncPeers = getAcceptedSyncPeerSignerMap(state).size;

  const configuredQuorum = Number(state.network?.requiredHeadQuorum || DEFAULT_CHAIN_HEAD_QUORUM);
  if (acceptedSyncPeers <= 1) {
    return 1;
  }

  return Math.min(configuredQuorum, acceptedSyncPeers);
}

function slashValidatorStake(state, wallet, amount) {
  const slashAmount = roundAmount(Math.max(0, Number(amount || 0)));
  if (!wallet || slashAmount <= 0) {
    return 0;
  }

  const fromStake = Math.min(getWalletStakeBalance(wallet), slashAmount);
  wallet.stakeBalance = roundAmount(getWalletStakeBalance(wallet) - fromStake);
  const remainder = roundAmount(slashAmount - fromStake);
  if (remainder > 0) {
    wallet.balance = roundAmount(Math.max(0, Number(wallet.balance || 0) - remainder));
  }

  state.economics.treasuryBalance = roundAmount((state.economics?.treasuryBalance || 0) + slashAmount);
  return slashAmount;
}

function signBlock(block, nodeSigner) {
  if (!nodeSigner?.privateKey || !nodeSigner?.publicKey) {
    return block;
  }

  const signedBlock = {
    ...block,
    signerPublicKey: nodeSigner.publicKey,
  };

  return {
    ...signedBlock,
    signature: signBlockPayload(signedBlock, nodeSigner.privateKey),
  };
}

function getNodeSigner(state) {
  const privateKey = state.network?.nodeSignerPrivateKey;
  const publicKey = state.network?.nodeSignerPublicKey;
  return privateKey && publicKey ? { privateKey, publicKey } : null;
}

function getWalletAcceptedNonce(wallet) {
  return Number.isInteger(wallet?.nextNonce) && wallet.nextNonce >= 0 ? wallet.nextNonce : 0;
}

function ensureWalletNonce(state, wallet) {
  if (!wallet) {
    return 0;
  }

  const usedNonces = (state.transactions || [])
    .filter((transaction) => transaction.senderAddress === wallet.address && Number.isInteger(transaction.nonce))
    .map((transaction) => transaction.nonce);
  const inferredNextNonce = usedNonces.length > 0 ? Math.max(...usedNonces) + 1 : 0;
  const nextNonce = Math.max(getWalletAcceptedNonce(wallet), inferredNextNonce);
  wallet.nextNonce = nextNonce;
  return nextNonce;
}

function assignWalletNonce(state, wallet) {
  const nonce = ensureWalletNonce(state, wallet);
  wallet.nextNonce = nonce + 1;
  return nonce;
}

function hasReplayConflict(transactions = [], transaction) {
  if (!transaction || !Number.isInteger(transaction.nonce) || transaction.nonce < 0) {
    return true;
  }

  return transactions.some((existing) => (
    existing.senderAddress === transaction.senderAddress &&
    existing.nonce === transaction.nonce &&
    existing.id !== transaction.id
  ));
}

function getPinnedPeerSigner(localState, remoteState) {
  const remoteUrl = normalizePeerUrl(remoteState?.network?.publicUrl);
  const remoteSigner = remoteState?.network?.nodeSignerPublicKey || null;

  if (!remoteSigner || !remoteUrl) {
    return null;
  }

  const trustedEntry = getTrustedPeerSignerEntry(localState, remoteUrl);
  if (!trustedEntry || trustedEntry.trustStatus !== 'trusted' || trustedEntry.trustStatus === 'revoked') {
    const protocolSigner = getAcceptedSyncPeerSignerMap(localState).get(remoteUrl);
    if (protocolSigner === remoteSigner) {
      return remoteSigner;
    }

    const peerEntry = (localState.peerRegistry || []).find((entry) => normalizePeerUrl(entry.url) === remoteUrl);
    if (
      peerEntry?.linkStatus === 'linked' &&
      peerEntry?.syncCapable &&
      peerEntry?.signerPublicKey === remoteSigner
    ) {
      return remoteSigner;
    }
    return null;
  }

  if (trustedEntry.signerPublicKey !== remoteSigner) {
    return null;
  }

  return remoteSigner;
}

function getAcceptedSyncPeerSignerMap(state) {
  const minimumEpoch = Math.max(1, Number(state.consensus?.currentEpoch || 1) - 1);
  const localValidatorSetHash = state.consensus?.validatorSetHash || null;
  const acceptedSigners = new Map(
    (state.consensus?.peerAnnouncements || [])
      .filter((entry) => (
        verifyPeerAnnouncement(entry) &&
        isPeerAnnouncementFresh(entry) &&
        Number(entry.epoch || 0) >= minimumEpoch &&
        (!localValidatorSetHash || !entry.validatorSetHash || entry.validatorSetHash === localValidatorSetHash)
      ))
      .map((entry) => [normalizePeerUrl(entry.url), entry.signerPublicKey])
  );

  for (const entry of state.peerRegistry || []) {
    if (entry.syncCapable && entry.linkStatus === 'linked' && entry.syncStatus !== 'revoked' && entry.signerPublicKey) {
      acceptedSigners.set(normalizePeerUrl(entry.url), entry.signerPublicKey);
    }
  }

  for (const entry of state.trustedPeerSigners || []) {
    const peerUrl = normalizePeerUrl(entry.url);
    if (!peerUrl || !entry.signerPublicKey) {
      continue;
    }

    if (entry.trustStatus === 'trusted' || entry.trustStatus === 'rotation-pending') {
      acceptedSigners.set(peerUrl, entry.signerPublicKey);
    }
  }

  return acceptedSigners;
}

function extractAppSnapshot(state) {
  return {
    network: structuredClone(state.network),
    manifest: structuredClone(state.manifest),
    economics: structuredClone(state.economics),
    featuredVideos: structuredClone(state.featuredVideos || []),
    rejectedVideos: structuredClone(state.rejectedVideos || []),
    wallets: structuredClone(state.wallets || []),
    pendingVideos: structuredClone(state.pendingVideos || []),
    transactions: structuredClone(state.transactions || []),
    peers: structuredClone(state.peers || []),
    peerRegistry: structuredClone(state.peerRegistry || []),
    trustedPeerSigners: structuredClone(state.trustedPeerSigners || []),
    chainObservations: structuredClone(state.chainObservations || []),
    chainHeadEndorsements: structuredClone(state.chainHeadEndorsements || []),
    adminActionLog: structuredClone(state.adminActionLog || []),
    validatorAttestations: structuredClone(state.validatorAttestations || []),
    moderationCases: structuredClone(state.moderationCases || []),
    listings: structuredClone(state.listings || []),
    consensusView: {
      protocol: state.consensus?.protocol || CONSENSUS_PROTOCOL,
      validatorRegistry: structuredClone(state.consensus?.validatorRegistry || []),
      validatorSetHash: state.consensus?.validatorSetHash || null,
      epochChanges: structuredClone(state.consensus?.epochChanges || []),
      peerAnnouncements: structuredClone(state.consensus?.peerAnnouncements || []),
    },
  };
}

function applyAppSnapshot(targetState, snapshot = {}) {
  targetState.network = structuredClone(snapshot.network || targetState.network);
  targetState.manifest = structuredClone(snapshot.manifest || targetState.manifest);
  targetState.economics = structuredClone(snapshot.economics || targetState.economics);
  targetState.featuredVideos = structuredClone(snapshot.featuredVideos || []);
  targetState.rejectedVideos = structuredClone(snapshot.rejectedVideos || []);
  targetState.wallets = structuredClone(snapshot.wallets || []);
  targetState.pendingVideos = structuredClone(snapshot.pendingVideos || []);
  targetState.transactions = structuredClone(snapshot.transactions || []);
  targetState.peers = structuredClone(snapshot.peers || []);
  targetState.peerRegistry = structuredClone(snapshot.peerRegistry || []);
  targetState.trustedPeerSigners = structuredClone(snapshot.trustedPeerSigners || []);
  targetState.chainObservations = structuredClone(snapshot.chainObservations || []);
  targetState.chainHeadEndorsements = structuredClone(snapshot.chainHeadEndorsements || []);
  targetState.adminActionLog = structuredClone(snapshot.adminActionLog || []);
  targetState.validatorAttestations = structuredClone(snapshot.validatorAttestations || []);
  targetState.moderationCases = structuredClone(snapshot.moderationCases || []);
  targetState.listings = structuredClone(snapshot.listings || []);
  targetState.consensus = {
    ...(targetState.consensus || {}),
    protocol: snapshot.consensusView?.protocol || targetState.consensus?.protocol || CONSENSUS_PROTOCOL,
    validatorRegistry: structuredClone(snapshot.consensusView?.validatorRegistry || []),
    validatorSetHash: snapshot.consensusView?.validatorSetHash || null,
    epochChanges: structuredClone(snapshot.consensusView?.epochChanges || []),
    peerAnnouncements: structuredClone(snapshot.consensusView?.peerAnnouncements || []),
  };
  return targetState;
}

function createSnapshotSignaturePayload(height, stateHash) {
  return {
    height: Number(height),
    stateHash,
    kind: 'app-state-snapshot',
  };
}

function extractEvidenceEntries(state) {
  const consensusEvidence = (state.consensus?.evidence || []).map((entry) => ({
    id: entry.id,
    category: 'consensus-evidence',
    refHeight: Number(entry.height || 0),
    payload: entry,
  }));
  const slashingEvents = (state.consensus?.slashingEvents || []).map((entry) => ({
    id: entry.id,
    category: 'slashing-event',
    refHeight: Number((state.chain?.find((block) => block.hash === entry.blockHash)?.height) || state.chain?.at?.(-1)?.height || 0),
    payload: entry,
  }));
  const moderationPending = (state.pendingVideos || []).map((entry) => ({
    id: `pending-${entry.id}`,
    category: 'moderation-pending',
    refHeight: Number(state.chain?.at?.(-1)?.height || 0),
    payload: entry,
  }));
  const moderationRejected = (state.rejectedVideos || []).map((entry) => ({
    id: `rejected-${entry.id}`,
    category: 'moderation-decision',
    refHeight: Number(state.chain?.find((block) => block.contentHash === entry.contentHash)?.height || state.chain?.at?.(-1)?.height || 0),
    payload: entry,
  }));
  const moderationCases = (state.moderationCases || []).map((entry) => ({
    id: `case-${entry.caseId}`,
    category: 'moderation-case',
    refHeight: Number(state.chain?.find((block) => block.hash === entry.finalDecision?.blockHash)?.height || state.chain?.at?.(-1)?.height || 0),
    payload: entry,
  }));
  const moderationVotes = (state.moderationCases || []).flatMap((entry) =>
    (entry.validatorVotes || []).map((vote) => ({
      id: `vote-${vote.id || sha256(stableStringify(vote)).slice(0, 16)}`,
      category: 'moderation-vote',
      refHeight: Number(state.chain?.find((block) => block.hash === entry.finalDecision?.blockHash)?.height || state.chain?.at?.(-1)?.height || 0),
      payload: vote,
    }))
  );

  return [
    ...consensusEvidence,
    ...slashingEvents,
    ...moderationPending,
    ...moderationRejected,
    ...moderationCases,
    ...moderationVotes,
  ];
}

function openStorageDatabase(storageDir) {
  const dbPath = path.join(storageDir, STATE_DB_FILE);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS storage_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS block_log (
      height INTEGER PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      parent_hash TEXT,
      epoch INTEGER NOT NULL,
      round INTEGER NOT NULL,
      finality_status TEXT NOT NULL,
      app_state_hash TEXT,
      block_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consensus_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      latest_finalized_height INTEGER NOT NULL,
      latest_round INTEGER NOT NULL,
      latest_epoch INTEGER NOT NULL,
      locked_qc_json TEXT,
      local_vote_state_json TEXT,
      validator_set_hash TEXT,
      latest_snapshot_height INTEGER,
      latest_snapshot_hash TEXT,
      latest_snapshot_signature TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_snapshots (
      height INTEGER PRIMARY KEY,
      state_hash TEXT NOT NULL,
      signature TEXT,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence_store (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      ref_height INTEGER,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO storage_meta (key, value)
    VALUES ('storage_engine', 'sqlite-wal')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
  return db;
}

function loadPersistedBlocks(db) {
  return db.prepare('SELECT block_json FROM block_log ORDER BY height ASC').all().map((row) => JSON.parse(row.block_json));
}

function verifySnapshotRecord(snapshotRecord, publicKey) {
  if (!snapshotRecord) {
    return false;
  }
  const signature = snapshotRecord.signature || null;
  if (!signature || !publicKey) {
    return false;
  }
  return verifyConsensusSignature(
    createSnapshotSignaturePayload(snapshotRecord.height, snapshotRecord.state_hash),
    publicKey,
    signature
  );
}

function createLegacyPayloadForMigration(block = {}) {
  const {
    id,
    prevHash,
    timestamp,
    hash,
    signature,
    signerPublicKey,
    height,
    round,
    epoch,
    parentHash,
    proposer,
    validatorSetHash,
    quorumCertificate,
    proposalCertificate,
    consensusLifecycle,
    finalityStatus,
    ...payload
  } = block;
  return {
    ...payload,
    timestamp: timestamp || new Date().toISOString(),
  };
}

function rebuildChainWithFormalFinality(state, inputChain = []) {
  const nextState = state;
  nextState.chain = [];
  ensureConsensusState(nextState);
  syncConsensusValidatorRegistry(nextState);
  nextState.consensus.currentRound = 0;
  nextState.consensus.lastFinalizedBlockHash = null;

  for (const block of inputChain) {
    const payload = createLegacyPayloadForMigration(block);
    const rebuilt = createBlock(nextState, payload);
    nextState.chain.push(rebuilt);
    nextState.consensus.lastFinalizedBlockHash = rebuilt.hash;
  }

  return nextState.chain;
}

function createInitialState() {
  const feeConfig = getFeeConfig();
  const nodeSigner = createWalletKeypair();
  const state = {
    network: {
      ...seedState.network,
      role: 'self-hosted-full-node',
      deployment: 'self-hosted',
      createdAt: new Date().toISOString(),
      publicUrl: null,
      node0Registration: null,
      persistence: 'sqlite-wal',
      writesEnabled: true,
      acceptedMediaMode: 'file-or-external-url',
      nodeSignerPublicKey: nodeSigner.publicKey,
      nodeSignerPrivateKey: nodeSigner.privateKey,
      nodeSignerKeyId: 'bootstrap-memory-key',
      keyManagement: {
        type: 'local-keystore',
        activeKeyId: 'bootstrap-memory-key',
        rotationPending: false,
      },
      notes: [
        'This node persists state in a local SQLite database with WAL enabled.',
        'Uploads are saved under /storage/media unless an external URL is provided.',
        'This mode is intended for VPS, Docker or local server deployments.',
      ],
    },
    manifest: {
      capabilities: [
        'wallet creation',
        'web transactions',
        'file uploads',
        'pending validation queue',
        'mining from the browser',
        'read-only explorer',
        'approved video listings',
        'wallet-to-wallet purchases',
        'configurable node economics',
      ],
      disabled: [],
      monetization: [
        ...(seedState.manifest.monetization || []),
        'approved video marketplace',
        'wallet-to-wallet content purchases',
        'creator royalties on purchases',
        'node-configurable transaction and marketplace fees',
      ],
    },
    economics: {
      ...feeConfig,
      treasuryBalance: 0,
      royaltyEnabled: true,
      updatedAt: new Date().toISOString(),
    },
    chain: [],
    featuredVideos: seedState.featuredVideos,
    rejectedVideos: [],
    wallets: [],
    pendingVideos: [],
    transactions: [],
    peers: [],
    peerRegistry: [],
    trustedPeerSigners: [],
    chainObservations: [],
    chainHeadEndorsements: [],
    adminActionLog: [],
    validatorAttestations: [],
    moderationCases: [],
    listings: [],
    consensus: {
      protocol: CONSENSUS_PROTOCOL,
      currentEpoch: 1,
      currentRound: 0,
      validatorRegistry: [],
      validatorSetHash: null,
      epochChanges: [],
      evidence: [],
      voteJournal: [],
      slashingEvents: [],
      peerAnnouncements: [],
      lastFinalizedBlockHash: null,
    },
  };
  syncConsensusValidatorRegistry(state);
  rebuildChainWithFormalFinality(state, normalizeChain(seedState.chain));
  state.network.nodeSignerPublicKey = nodeSigner.publicKey;
  state.network.nodeSignerPrivateKey = nodeSigner.privateKey;
  return state;
}

function prepareStateForPersistence(rawState) {
  if (!rawState) {
    return createInitialState();
  }

  const state = applyAppSnapshot(createInitialState(), {
    ...rawState,
    consensusView: rawState.consensus
      ? {
        protocol: rawState.consensus.protocol || CONSENSUS_PROTOCOL,
        validatorRegistry: rawState.consensus.validatorRegistry || [],
        validatorSetHash: rawState.consensus.validatorSetHash || null,
        epochChanges: rawState.consensus.epochChanges || [],
        peerAnnouncements: rawState.consensus.peerAnnouncements || [],
      }
      : undefined,
  });
  state.chain = Array.isArray(rawState.chain) && rawState.chain.length > 0
    ? rawState.chain
    : state.chain;
  ensureConsensusState(state);
  state.consensus = {
    ...state.consensus,
    currentEpoch: Number(rawState.consensus?.currentEpoch || state.consensus.currentEpoch || 1),
    currentRound: Number(rawState.consensus?.currentRound || state.consensus.currentRound || 0),
    evidence: structuredClone(rawState.consensus?.evidence || state.consensus.evidence || []),
    voteJournal: structuredClone(rawState.consensus?.voteJournal || state.consensus.voteJournal || []),
    slashingEvents: structuredClone(rawState.consensus?.slashingEvents || state.consensus.slashingEvents || []),
    peerAnnouncements: structuredClone(rawState.consensus?.peerAnnouncements || state.consensus.peerAnnouncements || []),
    lockedQC: structuredClone(rawState.consensus?.lockedQC || state.consensus.lockedQC || null),
    localVoteState: structuredClone(rawState.consensus?.localVoteState || state.consensus.localVoteState || null),
    latestSnapshotHeight: rawState.consensus?.latestSnapshotHeight ?? state.consensus.latestSnapshotHeight ?? null,
    latestSnapshotHash: rawState.consensus?.latestSnapshotHash || state.consensus.latestSnapshotHash || null,
    latestSnapshotSignature: rawState.consensus?.latestSnapshotSignature || state.consensus.latestSnapshotSignature || null,
  };
  syncConsensusValidatorRegistry(state);
  if (!isValidChain(state.chain || [])) {
    state.chain = normalizeChain(state.chain || []);
  }
  const needsFormalMigration = (state.chain || []).some((block, index) => (
    !Number.isInteger(block?.height) ||
    !Number.isInteger(block?.round) ||
    !Number.isInteger(block?.epoch) ||
    (block?.parentHash ?? null) !== (index === 0 ? null : state.chain[index - 1]?.hash ?? null) ||
    !block?.validatorSetHash ||
    !block?.quorumCertificate ||
    block?.finalityStatus !== 'finalized'
  ));
  if (needsFormalMigration) {
    rebuildChainWithFormalFinality(state, state.chain || []);
  }
  state.consensus.lastFinalizedBlockHash = state.chain?.at?.(-1)?.hash || null;
  return state;
}

async function writeLegacyCompatibleState(storageDir, state) {
  const legacyStatePath = path.join(storageDir, LEGACY_STATE_FILE);
  await fs.writeFile(legacyStatePath, JSON.stringify(state, null, 2), 'utf8');
}

const persistenceApi = createPersistenceApi({
  getStorageDir,
  getKeyStoreDir,
  getConfiguredNodeSigner,
  openStorageDatabase,
  loadPersistedBlocks,
  extractAppSnapshot,
  createInitialState,
  prepareStateForPersistence,
  applyAppSnapshot,
  ensureConsensusState,
  syncConsensusValidatorRegistry,
  isValidChain,
  normalizeChain,
  verifySnapshotRecord,
  writeLegacyCompatibleState,
  normalizeTrustedSignerEntry,
  normalizeChainObservationEntry,
  normalizeHeadEndorsement,
  normalizeAdminActionEntry,
  getFeeConfig,
  getMediaUploadPolicy,
  createWalletKeypair,
  getPublicKeyFromPrivateKey,
  sanitizeValidatorProfile,
  stableStringify,
  recomputeValidatorProfile,
  ensureWalletNonce,
  CONSENSUS_PROTOCOL,
  signConsensusPayload,
  createSnapshotSignaturePayload,
  sha256,
  extractEvidenceEntries,
  rebuildChainWithFormalFinality,
});

async function ensureStorage() {
  return persistenceApi.ensureStorage();
}

async function readState() {
  return persistenceApi.readState();
}

async function writeState(state) {
  return persistenceApi.writeState(state);
}

const federationApi = createFederationApi({
  exportNodeState,
  getPublicBaseUrl,
  normalizePeerUrl,
  getTrustedPeerSignerEntry,
  upsertPeerRegistryEntry,
  getNode0RegistrationTargets,
  getNode0RegistrationSecret,
  getIntegritySnapshot,
  sortUnique,
  validateConsensusStateView,
  isValidChain,
  getPinnedPeerSigner,
  recordChainObservation,
  mergeChainObservations,
  mergeHeadEndorsements,
  mergePeerAnnouncements,
  getTrustedObserverCountForHead,
  getRequiredHeadQuorum,
  appendConsensusEvidence,
  sanitizeConsensusRegistryEntry,
  mergeById,
  filterSignedTransactions,
  hasReplayConflict,
  ensureWalletNonce,
  readState,
  writeState,
  getPublicNodeState: async () => exportNodeState(await readState()),
  recordTrustedPeerSigner,
  revokeTrustedPeer,
  normalizeIsoDate,
  getWalletByAddress,
  assertWalletSecret,
  canParticipateAsValidator,
  upsertTrustedPeerSigner,
  commitState: async (state) => commitState(state),
  recordAdminAction,
});

const operatorApi = createOperatorApi({
  getGenesisNode0Url,
  getPublicBaseUrl,
  normalizePeerUrl,
  readState,
  writeState,
  getIntegritySnapshot,
  fetchAdvertisedIntegritySnapshot,
  registerPeer: async (payload) => federationApi.registerPeer(payload),
  getPublicNodeState: async () => exportNodeState(await readState()),
  recordAdminAction,
});

export async function getInternalNodeState() {
  return persistenceApi.getInternalNodeState();
}

export async function replaceInternalNodeState(nextState) {
  return persistenceApi.replaceInternalNodeState(nextState);
}

function createBlock(state, payload) {
  syncConsensusValidatorRegistry(state);
  const previous = state.chain.at(-1);
  const height = previous ? Number(previous.height || 0) + 1 : 0;
  const round = Number(state.consensus?.currentRound || 0) + 1;
  const epoch = Number(state.consensus?.currentEpoch || 1);
  const parentHash = previous?.hash ?? null;
  const proposer = normalizePeerUrl(state.network?.publicUrl) || 'self-hosted-node';
  const validatorSnapshot = getConsensusValidatorSnapshot(state);
  const validatorSetHash = computeValidatorSetHash(validatorSnapshot);
  const timestamp = new Date().toISOString();
  const proposedBlock = {
    id: String(height),
    height,
    round,
    epoch,
    prevHash: parentHash,
    parentHash,
    proposer,
    validatorSetHash,
    timestamp,
    ...payload,
  };
  let block = {
    ...proposedBlock,
    hash: computeBlockHash(proposedBlock),
  };
  const finality = createConsensusFinality({ ...block, __state: state }, validatorSnapshot);
  block = {
    ...block,
    proposalCertificate: finality.proposalCertificate,
    quorumCertificate: finality.quorumCertificate,
    consensusLifecycle: finality.consensusLifecycle,
    finalityStatus: finality.finalityStatus,
  };
  state.consensus.currentRound = round;
  state.consensus.lastFinalizedBlockHash = block.hash;
  return signBlock(block, getNodeSigner(state));
}

function getWalletByAddress(state, address) {
  return state.wallets.find((wallet) => wallet.address === address);
}

function assertWalletSecret(wallet, secret) {
  if (!wallet) {
    throw new Error('Wallet o secret inválidos.');
  }

  if (wallet.publicKey) {
    let publicKey = null;
    try {
      publicKey = getPublicKeyFromPrivateKey(secret);
    } catch {
      throw new Error('Wallet o secret inválidos.');
    }

    if (publicKey !== wallet.publicKey) {
      throw new Error('Wallet o secret inválidos.');
    }
    return;
  }

  if (wallet.secretHash !== sha256(secret)) {
    throw new Error('Wallet o secret inválidos.');
  }
}

function isLegacyTransaction(transaction) {
  return !transaction?.signature && !transaction?.senderPublicKey;
}

function filterSignedTransactions(transactions = [], wallets = []) {
  const walletKeyByAddress = new Map(
    wallets
      .filter((wallet) => wallet?.address)
      .map((wallet) => [wallet.address, wallet.publicKey || null])
  );

  return transactions.filter((transaction) => {
    if (isLegacyTransaction(transaction)) {
      return false;
    }

    const publicKey = transaction.senderPublicKey || walletKeyByAddress.get(transaction.senderAddress);
    if (!verifyTransactionSignature(transaction, publicKey)) {
      return false;
    }

    if (!Number.isInteger(transaction.nonce) || transaction.nonce < 0) {
      return false;
    }

    return !hasReplayConflict(transactions, transaction);
  });
}

function mergeById(current, incoming, key = 'id') {
  const map = new Map(current.map((item) => [item[key], item]));
  for (const item of incoming) {
    if (!map.has(item[key])) {
      map.set(item[key], item);
      continue;
    }

    map.set(item[key], {
      ...map.get(item[key]),
      ...item,
    });
  }
  return Array.from(map.values());
}

function getIntegritySnapshot(state) {
  return createIntegritySnapshot({
    mode: 'self-hosted',
    network: state.network,
    manifest: state.manifest,
    chain: state.chain,
    apiSurface: [
      '/api/bootstrap',
      '/api/manifest',
      '/api/chain',
      '/api/integrity',
      '/api/node/export',
      '/api/node/audit',
      '/api/node/peers',
      '/api/node/peers/revoke',
      '/api/node/peers/rotations',
      '/api/node/sync',
    ],
    publicUrl: getPublicBaseUrl() || null,
  });
}

async function broadcastState(state) {
  return federationApi.broadcastState(state);
}

async function announceNodePresence(state, options = {}) {
  return federationApi.announceNodePresence(state, options);
}

async function fetchAdvertisedIntegritySnapshot(publicUrl) {
  const response = await fetch(`${publicUrl}/api/integrity`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Public /api/integrity returned HTTP ${response.status}`);
  }

  return response.json();
}

async function probePeerUrl(peerUrl) {
  return federationApi.probePeerUrl(peerUrl);
}

function mergeRemoteState(localState, remoteState) {
  return federationApi.mergeRemoteState(localState, remoteState);
}

export async function resolveFederationTrustedSignerPublicKey(url) {
  const peerUrl = normalizePeerUrl(url);
  if (!peerUrl) {
    return null;
  }

  const state = await readState();
  return getAcceptedSyncPeerSignerMap(state).get(peerUrl) || null;
}

export async function getAdminAuditTrail() {
  const state = await readState();
  return (state.adminActionLog || []).map((entry) => normalizeAdminActionEntry(entry));
}

export async function getOperationalHealth() {
  const state = await readState();
  const lastAdminAction = (state.adminActionLog || [])[0] || null;
  return {
    persistence: state.network?.persistence || 'unknown',
    writesEnabled: Boolean(state.network?.writesEnabled),
    signerConfigured: Boolean(state.network?.nodeSignerPublicKey),
    signerKeyId: state.network?.keyManagement?.activeKeyId || state.network?.nodeSignerKeyId || null,
    publicUrl: state.network?.publicUrl || null,
    chainHeight: state.chain?.length || 0,
    trustedPeerCount: (state.trustedPeerSigners || []).filter((entry) => entry.trustStatus === 'trusted').length,
    revokedPeerCount: (state.trustedPeerSigners || []).filter((entry) => entry.trustStatus === 'revoked').length,
    adminActionCount: (state.adminActionLog || []).length,
    lastAdminAction: lastAdminAction ? normalizeAdminActionEntry(lastAdminAction) : null,
  };
}

export async function getPublicNodeState() {
  const state = await readState();
  return exportNodeState(state);
}

async function commitState(state) {
  syncConsensusValidatorRegistry(state);
  state.consensus.lastFinalizedBlockHash = state.chain?.at?.(-1)?.hash || null;
  state.economics = {
    ...state.economics,
    updatedAt: new Date().toISOString(),
  };
  await writeState(state);
  await broadcastState(state);
}

export async function createWallet({ username }) {
  if (!username?.trim()) {
    throw new Error('Debes ingresar un username.');
  }

  const state = await readState();
  const { publicKey, privateKey } = createWalletKeypair();
  const secret = privateKey;
  const address = sha256(`${username}:${Date.now()}:${publicKey}`).slice(0, 64);
  const wallet = {
    id: randomUUID(),
    username: username.trim(),
    address,
    balance: INITIAL_BALANCE,
    stakeBalance: INITIAL_VALIDATOR_BOND,
    secretHash: sha256(secret),
    publicKey,
    consensusPublicKey: publicKey,
    consensusPrivateKey: privateKey,
    createdAt: new Date().toISOString(),
    validatorBondedAt: new Date().toISOString(),
    validatorProfile: sanitizeValidatorProfile({
      humanIdentityCommitment: address,
      status: 'provisional',
    }),
    mediaCount: 0,
    reputation: 0,
    validatedCount: 0,
    nextNonce: 0,
  };

  state.wallets.push(wallet);
  state.chain.push(
    createBlock(state, {
      type: 'wallet',
      uploader: username.trim(),
      validator: 'self-hosted-node',
      mediaUrl: '',
      summary: `Nueva wallet creada para ${username.trim()}.`,
    })
  );
  await commitState(state);

  return {
    wallet: sanitizeWallet(wallet),
    secret,
    state: await getPublicNodeState(),
  };
}

export async function registerValidatorHumanity({ walletAddress, walletSecret, humanIdentityCommitment }) {
  if (!humanIdentityCommitment?.trim()) {
    throw new Error('Debes enviar un humanIdentityCommitment.');
  }

  const state = await readState();
  const wallet = getWalletByAddress(state, walletAddress);
  assertWalletSecret(wallet, walletSecret);

  wallet.validatorProfile = sanitizeValidatorProfile({
    ...getValidatorProfile(wallet),
    humanIdentityCommitment: humanIdentityCommitment.trim(),
  });
  recomputeValidatorProfile(state, wallet);
  await commitState(state);

  return {
    wallet: sanitizeWallet(wallet),
    state: await getPublicNodeState(),
  };
}

export async function attestValidatorHumanity({ attestorAddress, attestorSecret, candidateAddress, notes }) {
  const state = await readState();
  const attestor = getWalletByAddress(state, attestorAddress);
  const candidate = getWalletByAddress(state, candidateAddress);
  assertWalletSecret(attestor, attestorSecret);

  if (!candidate) {
    throw new Error('La wallet candidata no existe.');
  }
  if (attestorAddress === candidateAddress) {
    throw new Error('No puedes auto-atestiguar tu propia identidad.');
  }
  if (!hasValidatorBond(attestor)) {
    throw new Error(`El attestor necesita un bond mínimo de ${MIN_VALIDATOR_STAKE} SCH.`);
  }

  const attestorProfile = recomputeValidatorProfile(state, attestor);
  const candidateProfile = getValidatorProfile(candidate);
  if (!attestorProfile.humanIdentityCommitment) {
    throw new Error('El attestor debe registrar primero su identidad humana.');
  }
  if (!candidateProfile.humanIdentityCommitment) {
    throw new Error('La wallet candidata debe registrar primero su identidad humana.');
  }
  if (attestorProfile.humanIdentityCommitment === candidateProfile.humanIdentityCommitment) {
    throw new Error('El attestor debe tener un compromiso de identidad distinto al de la wallet candidata.');
  }

  const existing = (state.validatorAttestations || []).find((entry) => (
    entry.attestorAddress === attestorAddress &&
    entry.candidateAddress === candidateAddress
  ));
  if (existing) {
    throw new Error('Esa wallet ya atestiguó a la candidata.');
  }

  state.validatorAttestations.unshift({
    id: randomUUID(),
    attestorAddress,
    candidateAddress,
    attestorCommitment: attestorProfile.humanIdentityCommitment,
    candidateCommitment: candidateProfile.humanIdentityCommitment,
    notes: String(notes || '').trim(),
    timestamp: new Date().toISOString(),
  });

  candidate.validatorProfile = sanitizeValidatorProfile({
    ...candidateProfile,
    attestedBy: [...(candidateProfile.attestedBy || []), attestorAddress],
  });
  recomputeValidatorProfile(state, candidate);
  await commitState(state);

  return {
    candidate: sanitizeWallet(candidate),
    state: await getPublicNodeState(),
  };
}

export async function createTransaction({ senderAddress, senderSecret, receiverAddress, amount, summary, metadata, type = 'transfer' }) {
  const numericAmount = Number(amount);
  if (!numericAmount || numericAmount <= 0) {
    throw new Error('El amount debe ser mayor a 0.');
  }

  const state = await readState();
  const sender = getWalletByAddress(state, senderAddress);
  const receiver = getWalletByAddress(state, receiverAddress);
  assertWalletSecret(sender, senderSecret);

  if (!receiver) {
    throw new Error('La wallet destino no existe.');
  }

  const feeRate = Number(state.economics?.transactionFeeRate || 0);
  const feeAmount = roundAmount(numericAmount * feeRate);
  const totalCost = roundAmount(numericAmount + feeAmount);

  if (sender.balance < totalCost) {
    throw new Error(`Fondos insuficientes. Necesitas ${totalCost} SCH incluyendo fee.`);
  }

  sender.balance = roundAmount(sender.balance - totalCost);
  receiver.balance = roundAmount(receiver.balance + numericAmount);
  state.economics.treasuryBalance = roundAmount((state.economics?.treasuryBalance || 0) + feeAmount);
  const nonce = assignWalletNonce(state, sender);

  const tx = {
    id: randomUUID(),
    nonce,
    senderAddress,
    senderPublicKey: sender.publicKey || null,
    receiverAddress,
    amount: numericAmount,
    feeAmount,
    totalDebited: totalCost,
    timestamp: new Date().toISOString(),
    state: 'Success',
    type,
    summary: summary || `Transferencia de ${numericAmount} SCH`,
    metadata: metadata || null,
  };
  tx.signature = sender.publicKey ? signTransactionPayload(tx, senderSecret) : null;

  state.transactions.unshift(tx);
  state.chain.push(
    createBlock(state, {
      type: type === 'purchase' ? 'purchase' : 'transaction',
      uploader: sender.username,
      validator: receiver.username,
      mediaUrl: metadata?.mediaUrl || '',
      summary: summary || `Tx de ${numericAmount} SCH desde ${sender.username} hacia ${receiver.username} (fee ${feeAmount} SCH).`,
    })
  );

  await commitState(state);
  return { publicState: await getPublicNodeState(), transaction: tx };
}


const EXTENSION_TO_MEDIA_TYPE = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

function resolveMediaMimeType(file) {
  const declaredType = String(file?.type || '').trim().toLowerCase();
  if (declaredType) {
    return declaredType;
  }

  const extension = path.extname(String(file?.name || '')).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE.get(extension) || '';
}


function countWalletMediaEntries(state, uploaderAddress) {
  if (!uploaderAddress) {
    return 0;
  }

  return [
    ...(state.pendingVideos || []),
    ...(state.featuredVideos || []),
    ...(state.rejectedVideos || []),
  ].filter((entry) => entry.uploaderAddress === uploaderAddress || entry.creatorAddress === uploaderAddress || entry.ownerAddress === uploaderAddress).length;
}

function validateMediaUpload(file) {
  if (!file || Number(file.size || 0) <= 0) {
    return;
  }

  const policy = getMediaUploadPolicy();
  const mimeType = resolveMediaMimeType(file);
  if (!policy.allowedMimeTypes.includes(mimeType)) {
    throw new Error(`Tipo de archivo no permitido. Permitidos: ${policy.allowedMimeTypes.join(', ')}.`);
  }

  if (Number(file.size || 0) > policy.maxUploadBytes) {
    throw new Error(`El archivo excede el límite configurado de ${policy.maxUploadBytes} bytes.`);
  }
}

async function persistMediaFile(file) {
  validateMediaUpload(file);
  const { mediaDir } = await ensureStorage();
  const extension = path.extname(file.name || '') || '.bin';
  const filename = `${randomUUID()}${extension}`;
  const filepath = path.join(mediaDir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filepath, buffer);
  return {
    filename,
    url: `/api/node/media/${filename}`,
    size: buffer.byteLength,
  };
}

function scoreValidatorCandidate(wallet, contentHash) {
  const reputation = Number(wallet.reputation || 0);
  const validatedCount = Number(wallet.validatedCount || 0);
  const stakeBalance = getWalletStakeBalance(wallet);
  const sybilPenalty = wallet.mediaCount > 0 ? Math.min(wallet.mediaCount * 0.1, 1) : 0;
  const deterministicBias = Number(`0.${sha256(`${contentHash}:${wallet.address}`).slice(0, 8)}`);

  return (
    (reputation * 5) +
    (validatedCount * 3) +
    (Math.min(stakeBalance, 50) * 0.3) +
    deterministicBias -
    sybilPenalty
  );
}

function getFeaturedVideoByProof(state, proof) {
  return (state.featuredVideos || []).find((video) => video.proof === proof);
}

function getSuspiciousKeywordSignals(title) {
  const normalizedTitle = String(title || '').toLowerCase();
  const keywords = ['nsfw', 'xxx', 'gore', 'violent', 'violence', 'illegal', 'pirated', 'banned'];
  return keywords.filter((keyword) => normalizedTitle.includes(keyword)).map((keyword) => `keyword:${keyword}`);
}

function assessMediaRisk(state, { title, mediaUrl, contentHash, uploader }) {
  const signals = [
    ...getSuspiciousKeywordSignals(title),
  ];

  if ((state.featuredVideos || []).some((video) => video.contentHash === contentHash)) {
    signals.push('duplicate-featured-content-hash');
  }
  if ((state.rejectedVideos || []).some((video) => video.contentHash === contentHash)) {
    signals.push('matches-rejected-content-hash');
  }
  if ((state.pendingVideos || []).some((video) => video.contentHash === contentHash)) {
    signals.push('duplicate-pending-content-hash');
  }
  if (String(mediaUrl || '').startsWith('http://')) {
    signals.push('insecure-external-url');
  }
  if (uploader && Number(uploader.reputation || 0) < 0) {
    signals.push('low-uploader-reputation');
  }

  const riskScore = signals.reduce((score, signal) => {
    if (signal.startsWith('keyword:')) {
      return score + 2;
    }
    if (signal.includes('rejected') || signal.includes('duplicate')) {
      return score + 3;
    }
    return score + 1;
  }, 0);

  const canAutoApprove = (
    getActiveValidatorCount(state) >= VALIDATION_TARGET &&
    riskScore < LOW_RISK_AUTO_APPROVAL_THRESHOLD
  );

  return {
    riskScore,
    riskSignals: signals,
    canAutoApprove,
    needsEscalation: !canAutoApprove,
  };
}

function createApprovedVideoFromPending(pending, humanConsensus, overrides = {}) {
  const approvedAt = new Date().toISOString();
  return {
    title: pending.title,
    url: pending.mediaUrl,
    owner: pending.uploaderName,
    ownerAddress: pending.uploaderAddress,
    creatorName: pending.uploaderName,
    creatorAddress: pending.uploaderAddress,
    proof: pending.existingVideoProof || `sha256:${sha256(`${pending.id}:${pending.mediaUrl}`).slice(0, 24)}`,
    contentHash: pending.contentHash,
    validations: pending.validations || [],
    assignedValidators: pending.assignedValidators || [],
    approvedAt,
    status: 'approved',
    moderationState: overrides.moderationState || 'approved-human',
    moderationSource: overrides.moderationSource || 'escalated-review',
    challengeWindowEndsAt: overrides.challengeWindowEndsAt || null,
    riskScore: pending.riskScore || 0,
    riskSignals: pending.riskSignals || [],
    reviewStage: pending.reviewStage || 'initial',
    humanConsensus,
    transferCount: overrides.transferCount || 0,
    ownershipHistory: overrides.ownershipHistory || [
      {
        id: randomUUID(),
        ownerAddress: pending.uploaderAddress,
        ownerName: pending.uploaderName,
        acquiredAt: approvedAt,
        reason: 'mint',
      },
    ],
    ...overrides,
  };
}

function pickAssignedValidators(state, uploaderAddress, requiredValidations, contentHash, excludedValidators = []) {
  const candidates = state.wallets.filter((wallet) => wallet.address !== uploaderAddress);
  const trustedCandidates = candidates
    .filter((wallet) => !excludedValidators.includes(wallet.address))
    .filter((wallet) => canParticipateAsValidator(state, wallet) && ((wallet.validatedCount || 0) > 0 || (wallet.reputation || 0) > 0))
    .sort((left, right) => scoreValidatorCandidate(right, contentHash) - scoreValidatorCandidate(left, contentHash));

  const selected = [];
  for (const wallet of trustedCandidates) {
    if (selected.length >= requiredValidations) {
      break;
    }
    selected.push(wallet.address);
  }

  if (selected.length < requiredValidations) {
    const fallbackCandidates = candidates
      .filter((wallet) => !excludedValidators.includes(wallet.address))
      .filter((wallet) => canParticipateAsValidator(state, wallet) && !selected.includes(wallet.address))
      .sort((left, right) => {
        const scoreDiff = scoreValidatorCandidate(right, contentHash) - scoreValidatorCandidate(left, contentHash);
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return new Date(left.createdAt || 0) - new Date(right.createdAt || 0);
      });

    for (const wallet of fallbackCandidates) {
      if (selected.length >= requiredValidations) {
        break;
      }
      selected.push(wallet.address);
    }
  }

  if (selected.length < requiredValidations) {
    const emergencyCandidates = candidates
      .filter((wallet) => !excludedValidators.includes(wallet.address) && !selected.includes(wallet.address))
      .sort((left, right) => {
        const scoreDiff = scoreValidatorCandidate(right, contentHash) - scoreValidatorCandidate(left, contentHash);
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return new Date(left.createdAt || 0) - new Date(right.createdAt || 0);
      });

    for (const wallet of emergencyCandidates) {
      if (selected.length >= requiredValidations) {
        break;
      }
      selected.push(wallet.address);
    }
  }

  return selected.slice(0, requiredValidations);
}

function createPendingModerationRecord(base, moderationCase) {
  return {
    ...base,
    moderationCaseId: moderationCase.caseId,
    policyVersion: moderationCase.policyVersion,
    reasonCode: moderationCase.reasonCode,
    modelEvidenceRefs: moderationCase.modelEvidenceRefs,
    humanEvidenceRefs: moderationCase.humanEvidenceRefs,
    bondLocked: moderationCase.bondLocked,
  };
}

function attachModerationCaseToVideo(video, moderationCase) {
  if (!video || !moderationCase) {
    return;
  }
  video.moderationCaseId = moderationCase.caseId;
  video.policyVersion = moderationCase.policyVersion;
  video.reasonCode = moderationCase.reasonCode;
  video.riskSignals = moderationCase.riskSignals;
}

function lockModerationBond(wallet, amount) {
  const normalizedAmount = roundAmount(Number(amount || 0));
  if (normalizedAmount <= 0) {
    return 0;
  }
  if (Number(wallet?.balance || 0) < normalizedAmount) {
    throw new Error(`Fondos insuficientes para bloquear el bond de ${normalizedAmount} SCH.`);
  }
  wallet.balance = roundAmount(Number(wallet.balance || 0) - normalizedAmount);
  return normalizedAmount;
}

export async function createPendingMedia({ uploaderAddress, uploaderSecret, title, type, externalUrl, file }) {
  const normalizedType = type === 'memory' ? 'memory' : 'video';
  if (!title?.trim()) {
    throw new Error('Debes indicar un título.');
  }

  const state = await readState();
  const uploader = getWalletByAddress(state, uploaderAddress);
  assertWalletSecret(uploader, uploaderSecret);

  const uploadPolicy = getMediaUploadPolicy();
  if (countWalletMediaEntries(state, uploaderAddress) >= uploadPolicy.maxUploadsPerWallet) {
    throw new Error(`El actor ya alcanzó la cuota máxima de ${uploadPolicy.maxUploadsPerWallet} uploads.`);
  }

  let mediaUrl = externalUrl?.trim();
  let fileName = null;
  let size = 0;

  if (file && file.size > 0) {
    const stored = await persistMediaFile(file);
    mediaUrl = stored.url;
    fileName = stored.filename;
    size = stored.size;
  }

  if (!mediaUrl) {
    throw new Error('Debes subir un archivo o indicar una URL externa.');
  }

  const contentHash = sha256(
    fileName ? `${fileName}:${size}:${title.trim()}` : `${title.trim()}:${mediaUrl}:${normalizedType}`
  );
  const riskAssessment = assessMediaRisk(state, {
    title: title.trim(),
    mediaUrl,
    contentHash,
    uploader,
  });

  if (riskAssessment.canAutoApprove) {
    const autoPending = {
      id: randomUUID(),
      title: title.trim(),
      type: normalizedType,
      uploaderAddress,
      uploaderName: uploader.username,
      mediaUrl,
      fileName,
      size,
      contentHash,
      validations: [],
      assignedValidators: [],
      riskScore: riskAssessment.riskScore,
      riskSignals: riskAssessment.riskSignals,
      reviewStage: 'auto-approved',
    };
    const approvedVideo = createApprovedVideoFromPending(autoPending, null, {
      moderationState: 'approved-auto',
      moderationSource: 'risk-engine',
      challengeWindowEndsAt: new Date(Date.now() + (1000 * 60 * 60 * 24)).toISOString(),
    });
    uploader.balance += UPLOADER_REWARD;
    uploader.reputation = (uploader.reputation || 0) + 1;
    uploader.mediaCount += 1;
    state.featuredVideos.unshift(approvedVideo);
    state.chain.push(
      createBlock(state, {
        type: normalizedType,
        uploader: uploader.username,
        validator: 'risk-engine',
        mediaUrl,
        contentHash,
        moderationState: 'approved-auto',
        riskScore: riskAssessment.riskScore,
        riskSignals: riskAssessment.riskSignals,
        summary: `${title.trim()} aprobado automáticamente con ventana de challenge.`,
      })
    );
    await commitState(state);
    return getPublicNodeState();
  }

  const stakedCandidates = state.wallets.filter((wallet) => wallet.address !== uploaderAddress && canParticipateAsValidator(state, wallet)).length;
  const allCandidates = state.wallets.filter((wallet) => wallet.address !== uploaderAddress).length;
  const targetValidations = riskAssessment.riskScore >= 4
    ? ESCALATED_VALIDATION_TARGET
    : VALIDATION_TARGET;
  const requiredValidations = Math.min(
    targetValidations,
    Math.max(1, stakedCandidates > 0 ? stakedCandidates : allCandidates)
  );

  let pending = {
    id: randomUUID(),
    title: title.trim(),
    type: normalizedType,
    uploaderAddress,
    uploaderName: uploader.username,
    mediaUrl,
    fileName,
    size,
    contentHash,
    createdAt: new Date().toISOString(),
    confirmations: 0,
    validators: [],
    assignedValidators: pickAssignedValidators(state, uploaderAddress, requiredValidations, contentHash),
    requiredValidations,
    validations: [],
    status: 'pending-validation',
    moderationState: 'under-review',
    reviewStage: 'initial-escalation',
    riskScore: riskAssessment.riskScore,
    riskSignals: riskAssessment.riskSignals,
    rewardPool: MODERATION_REWARD_POOL,
    challengeReward: 0,
  };
  const moderationCase = createModerationCase({
    videoProof: `pending:${pending.id}`,
    openedBy: uploaderAddress,
    openedByName: uploader.username,
    reasonCode: normalizeReasonCode(null, riskAssessment.riskSignals.join(' ')),
    reasonText: 'Initial escalation triggered by risk engine.',
    riskSignals: riskAssessment.riskSignals,
    contentHash,
    caseType: 'escalation',
    sourcePendingId: pending.id,
  });
  pending = createPendingModerationRecord(pending, moderationCase);

  uploader.mediaCount += 1;
  state.moderationCases = state.moderationCases || [];
  upsertModerationCase(state, moderationCase);
  state.pendingVideos.unshift(pending);
  await commitState(state);
  return getPublicNodeState();
}

export async function flagFeaturedMedia({ proof, challengerAddress, challengerSecret, reason, reasonCode, evidenceHash }) {
  if (!reason?.trim()) {
    throw new Error('Debes indicar el motivo del flag.');
  }

  const state = await readState();
  const challenger = getWalletByAddress(state, challengerAddress);
  assertWalletSecret(challenger, challengerSecret);

  const featuredVideo = getFeaturedVideoByProof(state, proof);
  if (!featuredVideo) {
    throw new Error('Ese video aprobado no existe.');
  }
  if ((featuredVideo.moderationState || '').startsWith('challenged') || featuredVideo.moderationState === 'under-review') {
    throw new Error('Ese video ya está en revisión.');
  }
  const lockedBond = lockModerationBond(challenger, CHALLENGE_BOND);

  const requiredValidations = Math.min(
    ESCALATED_VALIDATION_TARGET,
    Math.max(1, state.wallets.filter((wallet) => wallet.address !== challengerAddress && canParticipateAsValidator(state, wallet)).length)
  );

  const humanEvidenceRef = createHumanEvidenceRef({
    actorAddress: challengerAddress,
    notes: reason,
    evidenceHash,
  });
  const moderationCase = createModerationCase({
    videoProof: featuredVideo.proof,
    openedBy: challengerAddress,
    openedByName: challenger.username,
    reasonCode,
    reasonText: reason,
    riskSignals: sortUnique([...(featuredVideo.riskSignals || []), 'manual-challenge']),
    contentHash: featuredVideo.contentHash,
    humanEvidenceRefs: [humanEvidenceRef],
    bondLocked: lockedBond,
    caseType: 'challenge',
  });
  const pending = createPendingModerationRecord({
    id: randomUUID(),
    existingVideoProof: featuredVideo.proof,
    title: featuredVideo.title,
    type: 'video',
    uploaderAddress: featuredVideo.creatorAddress || featuredVideo.ownerAddress,
    uploaderName: featuredVideo.creatorName || featuredVideo.owner,
    mediaUrl: featuredVideo.url,
    fileName: null,
    size: 0,
    contentHash: featuredVideo.contentHash,
    createdAt: new Date().toISOString(),
    confirmations: 0,
    validators: [],
    assignedValidators: pickAssignedValidators(state, challengerAddress, requiredValidations, featuredVideo.contentHash || featuredVideo.proof),
    requiredValidations,
    validations: [],
    status: 'pending-validation',
    moderationState: 'under-review',
    reviewStage: 'challenge',
    challengeReason: String(reason).trim(),
    challengerAddress,
    challengerName: challenger.username,
    riskScore: Math.max(3, Number(featuredVideo.riskScore || 0) + 2),
    riskSignals: sortUnique([...(featuredVideo.riskSignals || []), 'manual-challenge']),
    rewardPool: MODERATION_REWARD_POOL,
    challengeReward: CHALLENGE_SUCCESS_REWARD,
  }, moderationCase);

  featuredVideo.moderationState = 'challenged';
  featuredVideo.challengeReason = pending.challengeReason;
  featuredVideo.challengedAt = pending.createdAt;
  attachModerationCaseToVideo(featuredVideo, moderationCase);
  upsertModerationCase(state, moderationCase);
  state.pendingVideos.unshift(pending);
  state.chain.push(
    createBlock(state, {
      type: 'moderation-flag',
      uploader: challenger.username,
      validator: 'challenge-escalation',
      mediaUrl: featuredVideo.url,
      contentHash: featuredVideo.contentHash || null,
      reviewStage: 'challenge',
      reasonCode: moderationCase.reasonCode,
      moderationCaseId: moderationCase.caseId,
      bondLocked: lockedBond,
      summary: `${challenger.username} abrió challenge sobre ${featuredVideo.title}: ${pending.challengeReason}.`,
    })
  );
  await commitState(state);
  return getPublicNodeState();
}

export async function openModerationAppeal({ proof, caseId, appellantAddress, appellantSecret, reason, reasonCode, evidenceHash }) {
  if (!reason?.trim()) {
    throw new Error('Debes indicar el motivo de la apelación.');
  }

  const state = await readState();
  const appellant = getWalletByAddress(state, appellantAddress);
  assertWalletSecret(appellant, appellantSecret);

  const rejectedVideo = proof
    ? (state.rejectedVideos || []).find((entry) => entry.id === proof || entry.contentHash === proof || entry.title === proof)
    : null;
  const baseCase = caseId
    ? getModerationCaseById(state, caseId)
    : (rejectedVideo?.moderationCaseId
      ? getModerationCaseById(state, rejectedVideo.moderationCaseId)
      : getLatestModerationCaseForProof(state, proof || rejectedVideo?.id || null));
  const targetProof = proof || rejectedVideo?.id || baseCase?.videoProof;

  if (!targetProof || !baseCase) {
    throw new Error('No existe un caso de moderación elegible para apelar.');
  }
  if (!['resolved-rejected', 'resolved-approved'].includes(baseCase.status)) {
    throw new Error('Solo puedes apelar un caso ya resuelto.');
  }
  if ((baseCase.appealHistory || []).length >= MAX_CASE_APPEALS) {
    throw new Error(`Ese caso ya alcanzó el límite de ${MAX_CASE_APPEALS} apelaciones.`);
  }

  const lockedBond = lockModerationBond(appellant, APPEAL_BOND);
  const humanEvidenceRef = createHumanEvidenceRef({
    actorAddress: appellantAddress,
    notes: reason,
    evidenceHash,
  });
  const priorValidators = sortUnique((baseCase.validatorVotes || []).map((vote) => vote.validatorAddress));
  const requiredValidations = Math.min(
    ESCALATED_VALIDATION_TARGET,
    Math.max(1, state.wallets.filter((wallet) => wallet.address !== appellantAddress && canParticipateAsValidator(state, wallet)).length)
  );
  const appealCase = createModerationCase({
    videoProof: targetProof,
    openedBy: appellantAddress,
    openedByName: appellant.username,
    reasonCode,
    reasonText: reason,
    riskSignals: baseCase.riskSignals || [],
    contentHash: rejectedVideo?.contentHash || null,
    modelEvidenceRefs: baseCase.modelEvidenceRefs || [],
    humanEvidenceRefs: [...(baseCase.humanEvidenceRefs || []), humanEvidenceRef],
    bondLocked: lockedBond,
    caseType: 'appeal',
    appealOf: baseCase.caseId,
  });
  appealCase.appealsCount = Number((baseCase.appealHistory || []).length + 1);

  const pending = createPendingModerationRecord({
    id: randomUUID(),
    existingVideoProof: targetProof,
    title: rejectedVideo?.title || baseCase.videoProof,
    type: 'video',
    uploaderAddress: rejectedVideo?.ownerAddress || null,
    uploaderName: rejectedVideo?.owner || 'appeal',
    mediaUrl: rejectedVideo?.url || '',
    fileName: null,
    size: 0,
    contentHash: rejectedVideo?.contentHash || null,
    createdAt: new Date().toISOString(),
    confirmations: 0,
    validators: [],
    assignedValidators: pickAssignedValidators(state, appellantAddress, requiredValidations, rejectedVideo?.contentHash || targetProof, priorValidators),
    requiredValidations,
    validations: [],
    status: 'pending-validation',
    moderationState: 'under-review',
    reviewStage: 'appeal',
    challengeReason: String(reason).trim(),
    challengerAddress: appellantAddress,
    challengerName: appellant.username,
    riskScore: Math.max(2, Number(rejectedVideo?.riskScore || 0)),
    riskSignals: sortUnique(baseCase.riskSignals || []),
    rewardPool: MODERATION_REWARD_POOL,
    challengeReward: CHALLENGE_SUCCESS_REWARD,
  }, appealCase);

  baseCase.status = 'appealed';
  baseCase.appealHistory = [
    ...(baseCase.appealHistory || []),
    {
      caseId: appealCase.caseId,
      openedAt: appealCase.openedAt,
      openedBy: appellantAddress,
      bondLocked: lockedBond,
      reasonCode: appealCase.reasonCode,
    },
  ];
  upsertModerationCase(state, baseCase);
  upsertModerationCase(state, appealCase);
  state.pendingVideos.unshift(pending);
  state.chain.push(
    createBlock(state, {
      type: 'moderation-appeal',
      uploader: appellant.username,
      validator: 'appeal-escalation',
      mediaUrl: rejectedVideo?.url || '',
      contentHash: rejectedVideo?.contentHash || null,
      reviewStage: 'appeal',
      moderationCaseId: appealCase.caseId,
      reasonCode: appealCase.reasonCode,
      bondLocked: lockedBond,
      summary: `${appellant.username} abrió apelación para ${pending.title}: ${reason}.`,
    })
  );
  await commitState(state);
  return getPublicNodeState();
}

export async function validatePendingMedia({
  pendingId,
  validatorAddress,
  validatorSecret,
  authenticity,
  manipulated,
  duplicate,
  reasonCode,
  evidenceHash,
  notes,
}) {
  const state = await readState();
  const validator = getWalletByAddress(state, validatorAddress);
  assertWalletSecret(validator, validatorSecret);
  if (!canParticipateAsValidator(state, validator)) {
    throw new Error(`La wallet validadora necesita un bond mínimo de ${MIN_VALIDATOR_STAKE} SCH en stake.`);
  }

  const pending = state.pendingVideos.find((item) => item.id === pendingId);
  if (!pending) {
    throw new Error('No existe ese pending.');
  }

  if (pending.validators.includes(validatorAddress)) {
    throw new Error('Esa wallet ya validó este contenido.');
  }

  if (
    Array.isArray(pending.assignedValidators) &&
    pending.assignedValidators.length > 0 &&
    !pending.assignedValidators.includes(validatorAddress)
  ) {
    throw new Error('Esa wallet no fue asignada para validar este contenido.');
  }
  const moderationCase = pending.moderationCaseId ? getModerationCaseById(state, pending.moderationCaseId) : null;
  const normalizedReasonCode = normalizeReasonCode(reasonCode, notes);
  const moderationVoteTimestamp = new Date().toISOString();
  const signedModerationVote = signModerationVote({
    id: randomUUID(),
    caseId: moderationCase?.caseId || null,
    pendingId,
    validatorAddress,
    decision: authenticity === 'approve' ? 'approve' : 'reject',
    reasonCode: normalizedReasonCode,
    policyVersion: moderationCase?.policyVersion || MODERATION_POLICY_VERSION,
    evidenceHash: evidenceHash || createHumanEvidenceRef({
      actorAddress: validatorAddress,
      notes,
      timestamp: moderationVoteTimestamp,
    }).evidenceHash,
    timestamp: moderationVoteTimestamp,
  }, getConsensusPrivateKey(validator));
  const validation = {
    id: randomUUID(),
    validatorAddress,
    validatorName: validator.username,
    authenticity: authenticity === 'approve' ? 'approve' : 'reject',
    manipulated: Boolean(manipulated),
    duplicate: Boolean(duplicate),
    reasonCode: normalizedReasonCode,
    policyVersion: moderationCase?.policyVersion || MODERATION_POLICY_VERSION,
    evidenceHash: signedModerationVote.evidenceHash,
    signedDecision: signedModerationVote,
    notes: String(notes || '').trim(),
    timestamp: moderationVoteTimestamp,
  };

  pending.validators.push(validatorAddress);
  pending.validations.push(validation);
  pending.confirmations = pending.validations.length;
  if (moderationCase) {
    moderationCase.validatorVotes = [
      ...(moderationCase.validatorVotes || []).filter((vote) => vote.validatorAddress !== validatorAddress),
      signedModerationVote,
    ];
    moderationCase.status = pending.reviewStage === 'appeal' ? 'appeal-under-review' : 'under-review';
    upsertModerationCase(state, moderationCase);
  }

  if (pending.confirmations >= pending.requiredValidations) {
    const uploader = getWalletByAddress(state, pending.uploaderAddress);
    const approvals = pending.validations.filter(
      (item) => item.authenticity === 'approve' && !item.manipulated && !item.duplicate
    ).length;
    const rejections = pending.validations.length - approvals;
    const decision = approvals > rejections ? 'approved' : 'rejected';
    const humanConsensus = {
      approvals,
      rejections,
      requiredValidations: pending.requiredValidations,
      finalizedAt: new Date().toISOString(),
      mode: 'pow-plus-human-real-work',
    };
    const alignedValidatorAddresses = [];
    const misalignedValidatorAddresses = [];

    for (const item of pending.validations) {
      const votedApprove = item.authenticity === 'approve' && !item.manipulated && !item.duplicate;
      const aligned =
        (decision === 'approved' && votedApprove) ||
        (decision === 'rejected' && !votedApprove);
      if (aligned) {
        alignedValidatorAddresses.push(item.validatorAddress);
        const rewardedValidator = getWalletByAddress(state, item.validatorAddress);
        if (rewardedValidator) {
          rewardedValidator.reputation = (rewardedValidator.reputation || 0) + 1;
          rewardedValidator.validatedCount = (rewardedValidator.validatedCount || 0) + 1;
        }
      } else {
        misalignedValidatorAddresses.push(item.validatorAddress);
        const penalizedValidator = getWalletByAddress(state, item.validatorAddress);
        if (penalizedValidator) {
          const evidence = appendConsensusEvidence(state, {
            type: 'invalidProposalEvidence',
            validatorAddress: item.validatorAddress,
            blockHash: pending.contentHash || pending.id,
            height: state.chain.length,
            round: Number(state.consensus?.currentRound || 0),
            epoch: Number(state.consensus?.currentEpoch || 1),
            phase: 'moderation-review',
            details: {
              pendingId,
              decision,
              authenticity: item.authenticity,
              manipulated: item.manipulated,
              duplicate: item.duplicate,
            },
            slashed: true,
          });
          const slashAmount = slashValidatorStake(state, penalizedValidator, VALIDATOR_SLASH);
          recordSlashingEvent(state, penalizedValidator, slashAmount, 'invalidProposalEvidence', evidence);
          penalizedValidator.reputation = roundAmount(Math.max(0, Number(penalizedValidator.reputation || 0) - 1));
        }
      }
    }

    const rewardPool = Number(pending.rewardPool || 0);
    const rewardShare = alignedValidatorAddresses.length > 0
      ? roundAmount((rewardPool + (alignedValidatorAddresses.length * VALIDATOR_REWARD)) / alignedValidatorAddresses.length)
      : 0;
    for (const address of alignedValidatorAddresses) {
      const rewardedValidator = getWalletByAddress(state, address);
      if (rewardedValidator) {
        rewardedValidator.balance = roundAmount(Number(rewardedValidator.balance || 0) + rewardShare);
      }
    }

    let challengePayout = 0;
    const challengedVideo = pending.existingVideoProof ? getFeaturedVideoByProof(state, pending.existingVideoProof) : null;
    let challengeBondReturned = 0;
    let challengeBondSlashed = 0;
    const challengerSucceeded = (
      (pending.reviewStage === 'challenge' && decision === 'rejected') ||
      (pending.reviewStage === 'appeal' && decision === 'approved')
    );
    if (['challenge', 'appeal'].includes(pending.reviewStage) && challengerSucceeded && pending.challengerAddress) {
      const challenger = getWalletByAddress(state, pending.challengerAddress);
      if (challenger) {
        challengeBondReturned = roundAmount(Number(pending.bondLocked || 0));
        challengePayout = roundAmount(Number(pending.challengeReward || CHALLENGE_SUCCESS_REWARD));
        challenger.balance = roundAmount(Number(challenger.balance || 0) + challengePayout + challengeBondReturned);
      }
    } else if (['challenge', 'appeal'].includes(pending.reviewStage) && pending.challengerAddress) {
      challengeBondSlashed = roundAmount(Number(pending.bondLocked || 0));
      state.economics.treasuryBalance = roundAmount((state.economics?.treasuryBalance || 0) + challengeBondSlashed);
    }

    if (decision === 'approved' && challengedVideo) {
      challengedVideo.moderationState = 'approved-human';
      challengedVideo.humanConsensus = humanConsensus;
      challengedVideo.validations = pending.validations;
      challengedVideo.assignedValidators = pending.assignedValidators;
      challengedVideo.challengeResolvedAt = humanConsensus.finalizedAt;
      challengedVideo.challengeWindowEndsAt = null;
      challengedVideo.reasonCode = pending.reasonCode || challengedVideo.reasonCode || null;
      challengedVideo.policyVersion = pending.policyVersion || challengedVideo.policyVersion || MODERATION_POLICY_VERSION;
    } else if (decision === 'approved' && uploader) {
      uploader.balance += UPLOADER_REWARD;
      uploader.reputation = (uploader.reputation || 0) + 1;
      if (pending.reviewStage === 'appeal' && pending.existingVideoProof) {
        state.rejectedVideos = (state.rejectedVideos || []).filter((entry) => entry.id !== pending.existingVideoProof);
      }
      const approvedVideo = createApprovedVideoFromPending(pending, humanConsensus, {
        moderationState: 'approved-human',
        moderationSource: pending.reviewStage || 'escalated-review',
        reasonCode: pending.reasonCode || null,
        policyVersion: pending.policyVersion || MODERATION_POLICY_VERSION,
      });
      attachModerationCaseToVideo(approvedVideo, moderationCase);
      state.featuredVideos.unshift(approvedVideo);
    } else {
      if (challengedVideo) {
        state.featuredVideos = state.featuredVideos.filter((video) => video.proof !== challengedVideo.proof);
      }
      state.rejectedVideos.unshift({
        id: pending.existingVideoProof || pending.id,
        title: pending.title,
        url: pending.mediaUrl,
        owner: pending.uploaderName,
        ownerAddress: pending.uploaderAddress,
        contentHash: pending.contentHash,
        validations: pending.validations,
        humanConsensus,
        reviewStage: pending.reviewStage || 'initial-escalation',
        moderationCaseId: pending.moderationCaseId || null,
        reasonCode: pending.reasonCode || null,
        policyVersion: pending.policyVersion || MODERATION_POLICY_VERSION,
        challengerAddress: pending.challengerAddress || null,
        finalizedAt: humanConsensus.finalizedAt,
      });
    }

    if (moderationCase) {
      moderationCase.status = decision === 'approved' ? 'resolved-approved' : 'resolved-rejected';
      moderationCase.closedAt = humanConsensus.finalizedAt;
      moderationCase.finalDecision = {
        decision,
        finalizedAt: humanConsensus.finalizedAt,
        approvals,
        rejections,
        challengeBondReturned,
        challengeBondSlashed,
        blockHash: state.chain?.at?.(-1)?.hash || null,
      };
      moderationCase.resolutionSummary = `${pending.title} ${decision} bajo policy ${moderationCase.policyVersion}.`;
      if (pending.reviewStage === 'appeal') {
        moderationCase.appealsCount = Number(moderationCase.appealsCount || 0);
      }
      upsertModerationCase(state, moderationCase);
    }

    state.chain.push(
      createBlock(state, {
        type: pending.type,
        uploader: pending.uploaderName,
        validator: validator.username,
        mediaUrl: pending.mediaUrl,
        contentHash: pending.contentHash,
        decision,
        validationCount: pending.validations.length,
        humanConsensus,
        rewardPool,
        rewardShare,
        challengePayout,
        challengeBondReturned,
        challengeBondSlashed,
        reviewStage: pending.reviewStage || 'initial-escalation',
        moderationCaseId: pending.moderationCaseId || null,
        reasonCode: pending.reasonCode || normalizedReasonCode,
        policyVersion: pending.policyVersion || MODERATION_POLICY_VERSION,
        summary: `${pending.title} ${decision === 'approved' ? 'aprobado' : 'rechazado'} por Proof of TrueWork con reward pool de moderación.`,
      })
    );

    state.pendingVideos = state.pendingVideos.filter((item) => item.id !== pendingId);
  }

  await commitState(state);
  return getPublicNodeState();
}

function findApprovedVideo(state, proof) {
  return getFeaturedVideoByProof(state, proof);
}

export async function createVideoListing({ sellerAddress, sellerSecret, videoProof, price, description }) {
  const numericPrice = Number(price);
  if (!numericPrice || numericPrice <= 0) {
    throw new Error('El precio debe ser mayor a 0.');
  }

  const state = await readState();
  const seller = getWalletByAddress(state, sellerAddress);
  assertWalletSecret(seller, sellerSecret);

  const video = findApprovedVideo(state, videoProof);
  if (!video) {
    throw new Error('Ese video aprobado no existe.');
  }
  if (['challenged', 'under-review', 'restricted'].includes(video.moderationState)) {
    throw new Error('Ese video no puede listarse mientras esté en revisión/moderación.');
  }

  if (video.ownerAddress && video.ownerAddress !== sellerAddress) {
    throw new Error('Solo la wallet dueña puede listar este video.');
  }

  const existingListing = (state.listings || []).find((listing) => listing.videoProof === videoProof && listing.status === 'active');
  if (existingListing) {
    throw new Error('Ese video ya tiene un listing activo.');
  }

  const listing = {
    id: randomUUID(),
    videoProof,
    title: video.title,
    mediaUrl: video.url,
    contentHash: video.contentHash || null,
    sellerAddress,
    sellerName: seller.username,
    creatorAddress: video.creatorAddress || video.ownerAddress || sellerAddress,
    creatorName: video.creatorName || video.owner || seller.username,
    amount: numericPrice,
    currency: 'SCH',
    description: String(description || '').trim(),
    createdAt: new Date().toISOString(),
    status: 'active',
    saleTypeHint: getListingSaleType(video, sellerAddress),
    resaleLevel: getVideoTransferCount(video),
    currentOwnerAddress: sellerAddress,
    currentOwnerName: seller.username,
    purchaseCount: 0,
    purchaseHistory: [],
    lastPurchasedAt: null,
    soldAt: null,
  };

  state.listings.unshift(listing);
  state.chain.push(
    createBlock(state, {
      type: 'listing',
      uploader: seller.username,
      validator: 'marketplace',
      mediaUrl: video.url,
      contentHash: video.contentHash || null,
      summary: `${seller.username} listó ${video.title} por ${numericPrice} SCH.`,
    })
  );

  await commitState(state);
  return getPublicNodeState();
}

export async function purchaseVideoListing({ listingId, buyerAddress, buyerSecret }) {
  const state = await readState();
  const buyer = getWalletByAddress(state, buyerAddress);
  assertWalletSecret(buyer, buyerSecret);

  const listing = (state.listings || []).find((item) => item.id === listingId);
  if (!listing) {
    throw new Error('No existe ese listing.');
  }
  if (listing.status !== 'active') {
    throw new Error('Ese listing ya no está activo.');
  }
  if (listing.sellerAddress === buyerAddress) {
    throw new Error('No puedes comprar tu propio listing.');
  }

  const seller = getWalletByAddress(state, listing.sellerAddress);
  if (!seller) {
    throw new Error('La wallet vendedora ya no existe en el nodo.');
  }

  const video = findApprovedVideo(state, listing.videoProof);
  if (!video) {
    throw new Error('El video aprobado vinculado a este listing ya no existe.');
  }
  if (['challenged', 'under-review', 'restricted'].includes(video.moderationState)) {
    throw new Error('Ese video no puede comprarse mientras esté en revisión/moderación.');
  }
  if (video.ownerAddress && video.ownerAddress !== seller.address) {
    throw new Error('El ownership actual del video ya no coincide con la wallet vendedora.');
  }

  const creator = getWalletByAddress(state, listing.creatorAddress);
  const saleType = getListingSaleType(video, seller.address);
  const resaleLevel = getVideoTransferCount(video);
  const grossAmount = roundAmount(listing.amount);
  const marketplaceFeeAmount = roundAmount(grossAmount * Number(state.economics?.marketplaceFeeRate || 0));
  const royaltyApplies = Boolean(creator && creator.address !== seller.address && state.economics?.royaltyEnabled);
  const royaltyAmount = royaltyApplies
    ? roundAmount(grossAmount * Number(state.economics?.creatorRoyaltyRate || 0))
    : 0;
  const sellerAmount = roundAmount(grossAmount - marketplaceFeeAmount - royaltyAmount);

  if (buyer.balance < grossAmount) {
    throw new Error('Fondos insuficientes para comprar este video.');
  }

  buyer.balance = roundAmount(buyer.balance - grossAmount);
  seller.balance = roundAmount(seller.balance + sellerAmount);
  if (royaltyAmount > 0 && creator) {
    creator.balance = roundAmount(creator.balance + royaltyAmount);
  }
  state.economics.treasuryBalance = roundAmount((state.economics?.treasuryBalance || 0) + marketplaceFeeAmount);

  const transactionId = randomUUID();
  const timestamp = new Date().toISOString();
  const nonce = assignWalletNonce(state, buyer);
  const tx = {
    id: transactionId,
    nonce,
    senderAddress: buyerAddress,
    senderPublicKey: buyer.publicKey || null,
    receiverAddress: seller.address,
    amount: grossAmount,
    feeAmount: marketplaceFeeAmount,
    totalDebited: grossAmount,
    timestamp,
    state: 'Success',
    type: 'purchase',
    summary: `Compra de ${listing.title} por ${grossAmount} SCH.`,
    metadata: {
      listingId: listing.id,
      videoProof: listing.videoProof,
      mediaUrl: listing.mediaUrl,
      sellerAmount,
      royaltyAmount,
      marketplaceFeeAmount,
      creatorAddress: creator?.address || null,
      saleType,
      resaleLevel,
    },
  };
  tx.signature = buyer.publicKey ? signTransactionPayload(tx, buyerSecret) : null;

  listing.purchaseCount = (listing.purchaseCount || 0) + 1;
  listing.lastPurchasedAt = timestamp;
  listing.status = 'sold';
  listing.soldAt = timestamp;
  listing.saleType = saleType;
  listing.resaleLevel = resaleLevel;
  listing.currentOwnerAddress = buyer.address;
  listing.currentOwnerName = buyer.username;
  listing.purchaseHistory = listing.purchaseHistory || [];
  listing.purchaseHistory.unshift({
    id: randomUUID(),
    buyerAddress,
    buyerName: buyer.username,
    sellerAddress: seller.address,
    sellerName: seller.username,
    creatorAddress: creator?.address || null,
    creatorName: creator?.username || listing.creatorName || null,
    grossAmount,
    sellerAmount,
    royaltyAmount,
    marketplaceFeeAmount,
    purchasedAt: timestamp,
    transactionId,
    saleType,
    resaleLevel,
  });

  video.owner = buyer.username;
  video.ownerAddress = buyer.address;
  video.transferCount = resaleLevel + 1;
  video.lastTransferredAt = timestamp;
  video.ownershipHistory = [
    ...getVideoOwnershipHistory(video),
    {
      id: randomUUID(),
      ownerAddress: buyer.address,
      ownerName: buyer.username,
      acquiredAt: timestamp,
      reason: saleType,
      fromAddress: seller.address,
      fromName: seller.username,
      viaListingId: listing.id,
      transactionId,
      amount: grossAmount,
    },
  ];

  state.transactions.unshift(tx);
  state.chain.push(
    createBlock(state, {
      type: 'purchase',
      uploader: buyer.username,
      validator: seller.username,
      mediaUrl: listing.mediaUrl,
      contentHash: listing.contentHash || null,
      saleType,
      resaleLevel,
      summary: `${buyer.username} compró ${listing.title} (${saleType === 'primary' ? 'primary sale' : 'resale'}): seller ${sellerAmount} SCH, royalty ${royaltyAmount} SCH, fee ${marketplaceFeeAmount} SCH.`,
    })
  );

  await commitState(state);
  return getPublicNodeState();
}

export async function readMediaFile(filename) {
  const { mediaDir } = await ensureStorage();
  const filepath = path.join(mediaDir, path.basename(filename));
  return fs.readFile(filepath);
}

export async function registerWithNode0(payload) {
  return operatorApi.registerWithNode0(payload);
}

export async function registerPeer(payload) {
  return federationApi.registerPeer(payload);
}

export async function reviewPeerSignerRotation(payload) {
  return federationApi.reviewPeerSignerRotation(payload);
}

export async function revokePeerTrust(payload) {
  return federationApi.revokePeerTrust(payload);
}

export async function ingestRemoteState(payload) {
  return federationApi.ingestRemoteState(payload);
}
