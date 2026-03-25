import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  attestValidatorHumanity,
  createPendingMedia,
  createTransaction,
  createVideoListing,
  createWallet,
  flagFeaturedMedia,
  getAdminAuditTrail,
  getInternalNodeState,
  getPublicNodeState,
  ingestRemoteState,
  openModerationAppeal,
  purchaseVideoListing,
  replaceInternalNodeState,
  registerValidatorHumanity,
  reviewPeerSignerRotation,
  revokePeerTrust,
  validatePendingMedia,
} from '../lib/self-hosted-node.js';
import { computeBlockHash, createConsensusVotePayload, signBlockPayload, signConsensusPayload, verifyConsensusSignature } from '../lib/chain-security.js';

function useStorage(storageDir) {
  process.env.STREAMCHAIN_NODE_MODE = 'self-hosted';
  process.env.STREAMCHAIN_STORAGE_DIR = storageDir;
  delete process.env.STREAMCHAIN_PUBLIC_URL;
  delete process.env.STREAMCHAIN_NODE0_PEERS;
  delete process.env.STREAMCHAIN_NODE0_REGISTRATION_TARGETS;
}

async function createTempStorage(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function seedApprovedVideo({ title, uploader, uploaderSecret, validatorA, validatorASecret, validatorB, validatorBSecret }) {
  let state = await createPendingMedia({
    uploaderAddress: uploader,
    uploaderSecret,
    title,
    type: 'video',
    externalUrl: `https://example.com/${encodeURIComponent(title)}.mp4`,
  });
  const autoApproved = state.featuredVideos.find((item) => item.title === title && item.creatorAddress === uploader);
  if (autoApproved) {
    return autoApproved;
  }

  state = await getPublicNodeState();
  const pending = state.pendingVideos.find((item) => item.title === title);
  assert.ok(pending, 'pending video should exist after upload');

  await validatePendingMedia({
    pendingId: pending.id,
    validatorAddress: validatorA,
    validatorSecret: validatorASecret,
    authenticity: 'approve',
    manipulated: false,
    duplicate: false,
    notes: 'validator-a',
  });

  await validatePendingMedia({
    pendingId: pending.id,
    validatorAddress: validatorB,
    validatorSecret: validatorBSecret,
    authenticity: 'approve',
    manipulated: false,
    duplicate: false,
    notes: 'validator-b',
  });

  state = await getPublicNodeState();
  const video = state.featuredVideos.find((item) => item.title === title && item.creatorAddress === uploader);
  assert.ok(video, 'approved video should exist after validations');
  return video;
}

function assertFormalFinality(block, walletIndex = new Map(), bootstrapPublicKey = null) {
  assert.equal(block.finalityStatus, 'finalized');
  assert.ok(Number.isInteger(block.height));
  assert.ok(Number.isInteger(block.round));
  assert.ok(Number.isInteger(block.epoch));
  assert.equal(block.parentHash, block.prevHash);
  assert.ok(block.validatorSetHash);
  assert.ok(block.proposalCertificate);
  assert.ok(block.quorumCertificate);

  const certificates = [block.proposalCertificate, block.quorumCertificate];
  for (const certificate of certificates) {
    assert.equal(certificate.blockHash, block.hash);
    assert.equal(certificate.validatorSetHash, block.validatorSetHash);
    assert.ok(Array.isArray(certificate.validatorSnapshot));
    assert.ok(Array.isArray(certificate.votes));
    assert.ok(certificate.votes.length > 0);
    for (const vote of certificate.votes) {
      const payload = createConsensusVotePayload(vote);
      const snapshotEntry = certificate.validatorSnapshot.find((entry) => entry.validatorAddress === vote.validatorAddress);
      const publicKey = vote.validatorAddress === '__bootstrap_node_signer__'
        ? bootstrapPublicKey
        : (snapshotEntry?.consensusPublicKey || walletIndex.get(vote.validatorAddress)?.publicKey);
      assert.ok(publicKey, `missing public key for vote ${vote.validatorAddress}`);
      assert.ok(verifyConsensusSignature(payload, publicKey, vote.signature));
    }
  }
}

function createSignedPeerAnnouncement({
  url,
  signerPublicKey,
  signerPrivateKey,
  epoch = 1,
  observedAt = '2026-03-21T00:00:00.000Z',
  validatorSetHash = null,
  headHash = null,
}) {
  const announcement = {
    url,
    signerPublicKey,
    epoch,
    observedAt,
    ttlMs: 1000 * 60 * 30,
    expiresAt: new Date(new Date(observedAt).getTime() + (1000 * 60 * 30)).toISOString(),
    validatorSetHash,
    headHash,
    source: 'self-announced-peer',
  };
  announcement.signature = signConsensusPayload({
    url: announcement.url,
    signerPublicKey: announcement.signerPublicKey,
    epoch: announcement.epoch,
    observedAt: announcement.observedAt,
    ttlMs: announcement.ttlMs,
    expiresAt: announcement.expiresAt,
    validatorSetHash: announcement.validatorSetHash,
    headHash: announcement.headHash,
  }, signerPrivateKey);
  return announcement;
}

test('secondary market flow transfers ownership and exposes Step 4 metrics', async () => {
  const storageDir = await createTempStorage('streamchain-step5-market-');
  try {
    useStorage(storageDir);

    const alice = await createWallet({ username: 'alice-step5' });
    const validatorA = await createWallet({ username: 'validator-a-step5' });
    const validatorB = await createWallet({ username: 'validator-b-step5' });
    const buyer1 = await createWallet({ username: 'buyer-1-step5' });
    const buyer2 = await createWallet({ username: 'buyer-2-step5' });

    const approvedVideo = await seedApprovedVideo({
      title: 'step5-secondary-market',
      uploader: alice.wallet.address,
      uploaderSecret: alice.secret,
      validatorA: validatorA.wallet.address,
      validatorASecret: validatorA.secret,
      validatorB: validatorB.wallet.address,
      validatorBSecret: validatorB.secret,
    });

    await createVideoListing({
      sellerAddress: alice.wallet.address,
      sellerSecret: alice.secret,
      videoProof: approvedVideo.proof,
      price: 5,
      description: 'primary sale',
    });

    let state = await getPublicNodeState();
    const primaryListing = state.listings.find((listing) => listing.videoProof === approvedVideo.proof && listing.status === 'active');
    assert.ok(primaryListing, 'primary listing should be active');

    await purchaseVideoListing({
      listingId: primaryListing.id,
      buyerAddress: buyer1.wallet.address,
      buyerSecret: buyer1.secret,
    });

    await createVideoListing({
      sellerAddress: buyer1.wallet.address,
      sellerSecret: buyer1.secret,
      videoProof: approvedVideo.proof,
      price: 8,
      description: 'resale listing',
    });

    state = await getPublicNodeState();
    const resaleListing = state.listings.find((listing) => listing.videoProof === approvedVideo.proof && listing.status === 'active');
    assert.ok(resaleListing, 'resale listing should be active before second purchase');

    state = await purchaseVideoListing({
      listingId: resaleListing.id,
      buyerAddress: buyer2.wallet.address,
      buyerSecret: buyer2.secret,
    });

    const finalVideo = state.featuredVideos.find((item) => item.proof === approvedVideo.proof);
    const soldResaleListing = state.listings.find((listing) => listing.id === resaleListing.id);
    const buyer1Wallet = state.wallets.find((wallet) => wallet.address === buyer1.wallet.address);
    const creatorWallet = state.wallets.find((wallet) => wallet.address === alice.wallet.address);

    assert.equal(finalVideo.ownerAddress, buyer2.wallet.address);
    assert.equal(finalVideo.transferCount, 2);
    assert.equal(state.metrics.resaleSales, 1);
    assert.equal(state.metrics.soldListings, 2);
    assert.equal(soldResaleListing.status, 'sold');
    assert.equal(soldResaleListing.saleType, 'resale');
    assert.equal(buyer1Wallet.metrics.resaleSalesCount, 1);
    assert.ok(creatorWallet.metrics.royaltiesEarned > 0, 'creator should receive royalties on resale');
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('multi-node ingest updates existing listings and ownership transitions', async () => {
  const sourceStorage = await createTempStorage('streamchain-step5-source-');
  const replicaStorage = await createTempStorage('streamchain-step5-replica-');

  try {
    useStorage(sourceStorage);
    process.env.STREAMCHAIN_PUBLIC_URL = 'https://source-peer.example.com';

    const alice = await createWallet({ username: 'alice-sync-step5' });
    const validatorA = await createWallet({ username: 'validator-a-sync-step5' });
    const validatorB = await createWallet({ username: 'validator-b-sync-step5' });
    const buyer = await createWallet({ username: 'buyer-sync-step5' });

    const approvedVideo = await seedApprovedVideo({
      title: 'step5-sync-market',
      uploader: alice.wallet.address,
      uploaderSecret: alice.secret,
      validatorA: validatorA.wallet.address,
      validatorASecret: validatorA.secret,
      validatorB: validatorB.wallet.address,
      validatorBSecret: validatorB.secret,
    });

    await createVideoListing({
      sellerAddress: alice.wallet.address,
      sellerSecret: alice.secret,
      videoProof: approvedVideo.proof,
      price: 6,
      description: 'sync listing',
    });

    let sourceState = await getPublicNodeState();
    const activeListing = sourceState.listings.find((listing) => listing.videoProof === approvedVideo.proof && listing.status === 'active');
    assert.ok(activeListing, 'source node should expose active listing');

    useStorage(replicaStorage);
    process.env.STREAMCHAIN_PUBLIC_URL = 'https://replica-peer.example.com';
    let replicaState = await ingestRemoteState({ state: sourceState });
    let replicaListing = replicaState.listings.find((listing) => listing.id === activeListing.id);
    assert.equal(replicaListing.status, 'active');

    useStorage(sourceStorage);
    process.env.STREAMCHAIN_PUBLIC_URL = 'https://source-peer.example.com';
    await purchaseVideoListing({
      listingId: activeListing.id,
      buyerAddress: buyer.wallet.address,
      buyerSecret: buyer.secret,
    });
    sourceState = await getPublicNodeState();

    useStorage(replicaStorage);
    process.env.STREAMCHAIN_PUBLIC_URL = 'https://replica-peer.example.com';
    replicaState = await ingestRemoteState({ state: sourceState });
    replicaListing = replicaState.listings.find((listing) => listing.id === activeListing.id);
    const replicaVideo = replicaState.featuredVideos.find((video) => video.proof === approvedVideo.proof);

    assert.equal(replicaListing.status, 'sold');
    assert.equal(replicaListing.currentOwnerAddress, buyer.wallet.address);
    assert.equal(replicaVideo.ownerAddress, buyer.wallet.address);
    assert.equal(replicaState.metrics.soldListings, 1);
  } finally {
    await rm(sourceStorage, { recursive: true, force: true });
    await rm(replicaStorage, { recursive: true, force: true });
  }
});

test('transactions use monotonically increasing nonces and remote sync rejects replayed or unsigned transactions', async () => {
  const storageDir = await createTempStorage('streamchain-security-nonce-');

  try {
    useStorage(storageDir);

    const alice = await createWallet({ username: 'alice-nonce' });
    const bob = await createWallet({ username: 'bob-nonce' });

    const first = await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'tx-1',
    });

    const second = await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'tx-2',
    });

    assert.equal(first.transaction.nonce, 0);
    assert.equal(second.transaction.nonce, 1);

    const localState = await getPublicNodeState();
    const replayed = {
      ...second.transaction,
      id: 'forged-replay',
      summary: 'forged replay',
    };
    const unsigned = {
      ...second.transaction,
      id: 'unsigned-remote',
      nonce: 9,
      signature: null,
      senderPublicKey: null,
    };

    const mergedState = await ingestRemoteState({
      state: {
        ...localState,
        transactions: [...localState.transactions, replayed, unsigned],
      },
    });

    assert.equal(mergedState.transactions.filter((transaction) => transaction.senderAddress === alice.wallet.address).length, 2);
    assert.equal(mergedState.transactions.filter((transaction) => transaction.id === 'forged-replay').length, 0);
    assert.equal(mergedState.transactions.filter((transaction) => transaction.id === 'unsigned-remote').length, 0);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('validator assignment prioritizes staked validators with validation history before fresh sybil wallets', async () => {
  const storageDir = await createTempStorage('streamchain-validator-selection-');

  try {
    useStorage(storageDir);

    const uploader = await createWallet({ username: 'uploader-selection' });
    const trustedA = await createWallet({ username: 'trusted-a' });
    const trustedB = await createWallet({ username: 'trusted-b' });

    const seededVideo = await seedApprovedVideo({
      title: 'seed-validator-reputation',
      uploader: uploader.wallet.address,
      uploaderSecret: uploader.secret,
      validatorA: trustedA.wallet.address,
      validatorASecret: trustedA.secret,
      validatorB: trustedB.wallet.address,
      validatorBSecret: trustedB.secret,
    });
    assert.ok(seededVideo);

    const sybil1 = await createWallet({ username: 'sybil-1' });
    const sybil2 = await createWallet({ username: 'sybil-2' });
    assert.ok(sybil1.wallet.address && sybil2.wallet.address);

    await createPendingMedia({
      uploaderAddress: uploader.wallet.address,
      uploaderSecret: uploader.secret,
      title: 'validator-priority-check',
      type: 'video',
      externalUrl: 'https://example.com/validator-priority-check.mp4',
    });

    const state = await getPublicNodeState();
    const pending = state.pendingVideos.find((item) => item.title === 'validator-priority-check');
    assert.deepEqual(
      pending.assignedValidators.sort(),
      [trustedA.wallet.address, trustedB.wallet.address].sort(),
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('validator humanity attestations activate independent validators and keep duplicate commitments out of the active set', async () => {
  const storageDir = await createTempStorage('streamchain-validator-humanity-');

  try {
    useStorage(storageDir);

    const validatorA = await createWallet({ username: 'validator-human-a' });
    const validatorB = await createWallet({ username: 'validator-human-b' });
    const candidate = await createWallet({ username: 'candidate-human' });
    const duplicate = await createWallet({ username: 'duplicate-human' });

    await registerValidatorHumanity({
      walletAddress: validatorA.wallet.address,
      walletSecret: validatorA.secret,
      humanIdentityCommitment: 'human-a',
    });
    await registerValidatorHumanity({
      walletAddress: validatorB.wallet.address,
      walletSecret: validatorB.secret,
      humanIdentityCommitment: 'human-b',
    });
    await registerValidatorHumanity({
      walletAddress: candidate.wallet.address,
      walletSecret: candidate.secret,
      humanIdentityCommitment: 'human-candidate',
    });
    await registerValidatorHumanity({
      walletAddress: duplicate.wallet.address,
      walletSecret: duplicate.secret,
      humanIdentityCommitment: 'human-candidate',
    });

    await attestValidatorHumanity({
      attestorAddress: validatorA.wallet.address,
      attestorSecret: validatorA.secret,
      candidateAddress: validatorB.wallet.address,
      notes: 'independent human',
    });
    await attestValidatorHumanity({
      attestorAddress: candidate.wallet.address,
      attestorSecret: candidate.secret,
      candidateAddress: validatorB.wallet.address,
      notes: 'independent human 2',
    });
    await attestValidatorHumanity({
      attestorAddress: validatorB.wallet.address,
      attestorSecret: validatorB.secret,
      candidateAddress: validatorA.wallet.address,
      notes: 'independent human',
    });
    await attestValidatorHumanity({
      attestorAddress: candidate.wallet.address,
      attestorSecret: candidate.secret,
      candidateAddress: validatorA.wallet.address,
      notes: 'independent human 2',
    });

    let state = await getPublicNodeState();
    let validatorAPublic = state.wallets.find((wallet) => wallet.address === validatorA.wallet.address);
    let validatorBPublic = state.wallets.find((wallet) => wallet.address === validatorB.wallet.address);
    let duplicatePublic = state.wallets.find((wallet) => wallet.address === duplicate.wallet.address);

    assert.equal(validatorAPublic.validatorProfile.status, 'active');
    assert.equal(validatorBPublic.validatorProfile.status, 'active');
    assert.equal(duplicatePublic.validatorProfile.uniquenessViolations, 1);
    assert.notEqual(duplicatePublic.validatorProfile.status, 'active');

    await createPendingMedia({
      uploaderAddress: candidate.wallet.address,
      uploaderSecret: candidate.secret,
      title: 'violent-strict-humanity-check',
      type: 'video',
      externalUrl: 'https://example.com/strict-humanity-check.mp4',
    });
    state = await getPublicNodeState();
    const pending = state.pendingVideos.find((item) => item.title === 'violent-strict-humanity-check');
    assert.deepEqual(
      pending.assignedValidators.sort(),
      [validatorA.wallet.address, validatorB.wallet.address].sort(),
    );

    await assert.rejects(
      validatePendingMedia({
        pendingId: pending.id,
        validatorAddress: duplicate.wallet.address,
        validatorSecret: duplicate.secret,
        authenticity: 'approve',
        manipulated: false,
        duplicate: false,
        notes: 'sybil attempt',
      }),
      /bond mínimo|no fue asignada/i,
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('media uploads reject disallowed mime types and oversized files before persistence', async () => {
  const storageDir = await createTempStorage('streamchain-media-upload-policy-');
  useStorage(storageDir);
  process.env.STREAMCHAIN_MEDIA_MAX_UPLOAD_BYTES = '16';
  process.env.STREAMCHAIN_MEDIA_ALLOWED_MIME_TYPES = 'video/mp4,image/png';

  try {
    const uploader = await createWallet({ username: 'uploader-policy' });

    await assert.rejects(() => createPendingMedia({
      uploaderAddress: uploader.wallet.address,
      uploaderSecret: uploader.secret,
      title: 'Blocked executable',
      type: 'video',
      file: new File([Buffer.from('pretend-binary')], 'payload.exe', { type: 'application/x-msdownload' }),
    }), /Tipo de archivo no permitido/i);

    await assert.rejects(() => createPendingMedia({
      uploaderAddress: uploader.wallet.address,
      uploaderSecret: uploader.secret,
      title: 'Huge mp4',
      type: 'video',
      file: new File([Buffer.from('1234567890abcdefghij')], 'clip.mp4', { type: 'video/mp4' }),
    }), /excede el límite configurado/i);
  } finally {
    delete process.env.STREAMCHAIN_MEDIA_MAX_UPLOAD_BYTES;
    delete process.env.STREAMCHAIN_MEDIA_ALLOWED_MIME_TYPES;
    await rm(storageDir, { recursive: true, force: true });
  }
});


test('wallet upload quota blocks additional media after the configured limit', async () => {
  const storageDir = await createTempStorage('streamchain-media-wallet-quota-');
  useStorage(storageDir);
  process.env.STREAMCHAIN_MEDIA_MAX_UPLOADS_PER_WALLET = '1';

  try {
    const uploader = await createWallet({ username: 'uploader-quota' });

    await createPendingMedia({
      uploaderAddress: uploader.wallet.address,
      uploaderSecret: uploader.secret,
      title: 'First quota upload',
      type: 'video',
      externalUrl: 'https://example.com/first.mp4',
    });

    await assert.rejects(() => createPendingMedia({
      uploaderAddress: uploader.wallet.address,
      uploaderSecret: uploader.secret,
      title: 'Second quota upload',
      type: 'video',
      externalUrl: 'https://example.com/second.mp4',
    }), /cuota máxima de 1 uploads/i);
  } finally {
    delete process.env.STREAMCHAIN_MEDIA_MAX_UPLOADS_PER_WALLET;
    await rm(storageDir, { recursive: true, force: true });
  }
});


test('low-risk media can auto-approve and challenged moderation distributes economic rewards', async () => {
  const storageDir = await createTempStorage('streamchain-auto-moderation-');

  try {
    useStorage(storageDir);

    const validatorA = await createWallet({ username: 'validator-auto-a' });
    const validatorB = await createWallet({ username: 'validator-auto-b' });
    const supporter = await createWallet({ username: 'supporter-auto' });
    const uploader = await createWallet({ username: 'uploader-auto' });
    const challenger = await createWallet({ username: 'challenger-auto' });

    await registerValidatorHumanity({
      walletAddress: validatorA.wallet.address,
      walletSecret: validatorA.secret,
      humanIdentityCommitment: 'auto-human-a',
    });
    await registerValidatorHumanity({
      walletAddress: validatorB.wallet.address,
      walletSecret: validatorB.secret,
      humanIdentityCommitment: 'auto-human-b',
    });
    await registerValidatorHumanity({
      walletAddress: supporter.wallet.address,
      walletSecret: supporter.secret,
      humanIdentityCommitment: 'auto-human-c',
    });

    await attestValidatorHumanity({
      attestorAddress: validatorA.wallet.address,
      attestorSecret: validatorA.secret,
      candidateAddress: validatorB.wallet.address,
      notes: 'independent',
    });
    await attestValidatorHumanity({
      attestorAddress: supporter.wallet.address,
      attestorSecret: supporter.secret,
      candidateAddress: validatorB.wallet.address,
      notes: 'independent',
    });
    await attestValidatorHumanity({
      attestorAddress: validatorB.wallet.address,
      attestorSecret: validatorB.secret,
      candidateAddress: validatorA.wallet.address,
      notes: 'independent',
    });
    await attestValidatorHumanity({
      attestorAddress: supporter.wallet.address,
      attestorSecret: supporter.secret,
      candidateAddress: validatorA.wallet.address,
      notes: 'independent',
    });

    let state = await createPendingMedia({
      uploaderAddress: uploader.wallet.address,
      uploaderSecret: uploader.secret,
      title: 'calm-travel-diary',
      type: 'video',
      externalUrl: 'https://example.com/calm-travel-diary.mp4',
    });

    const approvedVideo = state.featuredVideos.find((item) => item.title === 'calm-travel-diary');
    assert.equal(state.pendingVideos.find((item) => item.title === 'calm-travel-diary'), undefined);
    assert.equal(approvedVideo.moderationState, 'approved-auto');
    assert.equal(state.moderationCases.find((entry) => entry.videoProof === approvedVideo.proof), undefined);

    const challengerBefore = state.wallets.find((wallet) => wallet.address === challenger.wallet.address);

    state = await flagFeaturedMedia({
      proof: approvedVideo.proof,
      challengerAddress: challenger.wallet.address,
      challengerSecret: challenger.secret,
      reasonCode: 'fraudulent-edit',
      reason: 'possible policy issue',
    });

    const moderationPending = state.pendingVideos.find((item) => item.existingVideoProof === approvedVideo.proof);
    const challengeCase = state.moderationCases.find((entry) => entry.caseId === moderationPending.moderationCaseId);
    assert.equal(state.featuredVideos.find((item) => item.proof === approvedVideo.proof).moderationState, 'challenged');
    assert.equal(moderationPending.reviewStage, 'challenge');
    assert.equal(challengeCase.reasonCode, 'fraudulent-edit');
    assert.equal(challengeCase.policyVersion, '1.3');
    assert.equal(challengeCase.bondLocked, 1);
    assert.equal(challengerBefore.balance - state.wallets.find((wallet) => wallet.address === challenger.wallet.address).balance, 1);

    await validatePendingMedia({
      pendingId: moderationPending.id,
      validatorAddress: validatorA.wallet.address,
      validatorSecret: validatorA.secret,
      authenticity: 'reject',
      manipulated: true,
      duplicate: false,
      reasonCode: 'fraudulent-edit',
      notes: 'confirmed policy issue',
    });
    state = await validatePendingMedia({
      pendingId: moderationPending.id,
      validatorAddress: validatorB.wallet.address,
      validatorSecret: validatorB.secret,
      authenticity: 'reject',
      manipulated: true,
      duplicate: false,
      reasonCode: 'fraudulent-edit',
      notes: 'confirmed policy issue',
    });

    const challengerAfter = state.wallets.find((wallet) => wallet.address === challenger.wallet.address);
    const validatorAAfter = state.wallets.find((wallet) => wallet.address === validatorA.wallet.address);
    const resolvedCase = state.moderationCases.find((entry) => entry.caseId === challengeCase.caseId);

    assert.equal(state.featuredVideos.find((item) => item.proof === approvedVideo.proof), undefined);
    assert.ok(state.rejectedVideos.find((item) => item.id === approvedVideo.proof));
    assert.ok(challengerAfter.balance > challengerBefore.balance);
    assert.ok(validatorAAfter.balance > validatorA.wallet.balance);
    assert.equal(resolvedCase.status, 'resolved-rejected');
    assert.equal(resolvedCase.finalDecision.challengeBondReturned, 1);
    assert.equal(resolvedCase.validatorVotes.length, 2);
    assert.ok(resolvedCase.validatorVotes.every((vote) => vote.signature));
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('misaligned validators are slashed from bonded stake and approved media records human consensus', async () => {
  const storageDir = await createTempStorage('streamchain-validator-slash-');

  try {
    useStorage(storageDir);

    const uploader = await createWallet({ username: 'uploader-slash' });
    const honestValidator = await createWallet({ username: 'honest-validator' });
    const maliciousValidator = await createWallet({ username: 'malicious-validator' });
    const tieBreakerValidator = await createWallet({ username: 'tie-breaker-validator' });

    await createPendingMedia({
      uploaderAddress: uploader.wallet.address,
      uploaderSecret: uploader.secret,
      title: 'human-consensus-video',
      type: 'video',
      externalUrl: 'https://example.com/human-consensus-video.mp4',
    });

    const internalState = await getInternalNodeState();
    const pendingInternal = internalState.pendingVideos.find((item) => item.title === 'human-consensus-video');
    pendingInternal.requiredValidations = 3;
    pendingInternal.assignedValidators = [
      honestValidator.wallet.address,
      maliciousValidator.wallet.address,
      tieBreakerValidator.wallet.address,
    ];
    await replaceInternalNodeState(internalState);

    let state = await getPublicNodeState();
    const pending = state.pendingVideos.find((item) => item.title === 'human-consensus-video');
    const maliciousBefore = state.wallets.find((wallet) => wallet.address === maliciousValidator.wallet.address);
    assert.equal(maliciousBefore.stakeBalance, 5);

    await validatePendingMedia({
      pendingId: pending.id,
      validatorAddress: honestValidator.wallet.address,
      validatorSecret: honestValidator.secret,
      authenticity: 'approve',
      manipulated: false,
      duplicate: false,
      notes: 'looks authentic',
    });

    await validatePendingMedia({
      pendingId: pending.id,
      validatorAddress: maliciousValidator.wallet.address,
      validatorSecret: maliciousValidator.secret,
      authenticity: 'reject',
      manipulated: true,
      duplicate: false,
      notes: 'false negative',
    });

    state = await validatePendingMedia({
      pendingId: pending.id,
      validatorAddress: tieBreakerValidator.wallet.address,
      validatorSecret: tieBreakerValidator.secret,
      authenticity: 'approve',
      manipulated: false,
      duplicate: false,
      notes: 'consensus approve',
    });

    const approved = state.featuredVideos.find((item) => item.title === 'human-consensus-video');
    const maliciousAfter = state.wallets.find((wallet) => wallet.address === maliciousValidator.wallet.address);
    const finalizedBlock = state.chain.at(-1);

    assert.equal(approved.humanConsensus.mode, 'pow-plus-human-real-work');
    assert.equal(approved.humanConsensus.approvals, 2);
    assert.equal(approved.humanConsensus.rejections, 1);
    assert.equal(maliciousAfter.stakeBalance, 3);
    assert.equal(state.economics.treasuryBalance, 2);
    assert.ok(state.chainConsensus.validatorRegistry.length >= 3);
    assert.ok(state.chainConsensus.evidence.some((entry) => entry.type === 'invalidProposalEvidence'));
    assert.ok(state.chainConsensus.slashingEvents.some((entry) => entry.validatorAddress === maliciousValidator.wallet.address));
    assertFormalFinality(
      finalizedBlock,
      new Map(state.wallets.map((wallet) => [wallet.address, wallet])),
      state.network.nodeSignerPublicKey,
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('formal appeals create a new moderation case with a fresh validator set and refund bond only when the appeal succeeds', async () => {
  const storageDir = await createTempStorage('streamchain-appeal-case-');

  try {
    useStorage(storageDir);

    const uploader = await createWallet({ username: 'uploader-appeal' });
    const validatorA = await createWallet({ username: 'validator-appeal-a' });
    const validatorB = await createWallet({ username: 'validator-appeal-b' });
    const validatorC = await createWallet({ username: 'validator-appeal-c' });
    const appellant = await createWallet({ username: 'appellant-appeal' });

    await createPendingMedia({
      uploaderAddress: uploader.wallet.address,
      uploaderSecret: uploader.secret,
      title: 'appealable-video',
      type: 'video',
      externalUrl: 'https://example.com/appealable-video.mp4',
    });

    let state = await getInternalNodeState();
    const pending = state.pendingVideos.find((item) => item.title === 'appealable-video');
    pending.requiredValidations = 2;
    pending.assignedValidators = [validatorA.wallet.address, validatorB.wallet.address];
    await replaceInternalNodeState(state);

    await validatePendingMedia({
      pendingId: pending.id,
      validatorAddress: validatorA.wallet.address,
      validatorSecret: validatorA.secret,
      authenticity: 'reject',
      manipulated: true,
      duplicate: false,
      reasonCode: 'fraudulent-edit',
      notes: 'reject-a',
    });
    state = await validatePendingMedia({
      pendingId: pending.id,
      validatorAddress: validatorB.wallet.address,
      validatorSecret: validatorB.secret,
      authenticity: 'reject',
      manipulated: true,
      duplicate: false,
      reasonCode: 'fraudulent-edit',
      notes: 'reject-b',
    });

    const rejected = state.rejectedVideos.find((item) => item.title === 'appealable-video');
    const rejectedCase = state.moderationCases.find((entry) => entry.caseId === rejected.moderationCaseId);
    const appellantBefore = state.wallets.find((wallet) => wallet.address === appellant.wallet.address);

    state = await openModerationAppeal({
      proof: rejected.id,
      appellantAddress: appellant.wallet.address,
      appellantSecret: appellant.secret,
      reasonCode: 'policy-other',
      reason: 'please review with different validators',
    });

    const appealPending = state.pendingVideos.find((item) => item.reviewStage === 'appeal' && item.existingVideoProof === rejected.id);
    const appealCase = state.moderationCases.find((entry) => entry.caseId === appealPending.moderationCaseId);
    const appellantLocked = state.wallets.find((wallet) => wallet.address === appellant.wallet.address);

    assert.equal(appellantBefore.balance - appellantLocked.balance, 1);
    assert.equal(appealCase.appealOf, rejectedCase.caseId);
    assert.ok(!appealPending.assignedValidators.includes(validatorA.wallet.address));
    assert.ok(!appealPending.assignedValidators.includes(validatorB.wallet.address));

    state = await replaceInternalNodeState({
      ...await getInternalNodeState(),
      pendingVideos: (await getInternalNodeState()).pendingVideos.map((item) => item.id === appealPending.id
        ? { ...item, requiredValidations: 2, assignedValidators: [validatorC.wallet.address, appellant.wallet.address] }
        : item),
    });

    await validatePendingMedia({
      pendingId: appealPending.id,
      validatorAddress: validatorC.wallet.address,
      validatorSecret: validatorC.secret,
      authenticity: 'approve',
      manipulated: false,
      duplicate: false,
      reasonCode: 'policy-other',
      notes: 'approve-c',
    });
    state = await validatePendingMedia({
      pendingId: appealPending.id,
      validatorAddress: appellant.wallet.address,
      validatorSecret: appellant.secret,
      authenticity: 'approve',
      manipulated: false,
      duplicate: false,
      reasonCode: 'policy-other',
      notes: 'approve-appellant',
    });

    const reinstated = state.featuredVideos.find((item) => item.title === 'appealable-video');
    const appellantAfter = state.wallets.find((wallet) => wallet.address === appellant.wallet.address);
    const resolvedAppeal = state.moderationCases.find((entry) => entry.caseId === appealCase.caseId);

    assert.ok(reinstated);
    assert.equal(resolvedAppeal.status, 'resolved-approved');
    assert.equal(resolvedAppeal.finalDecision.challengeBondReturned, 1);
    assert.ok(appellantAfter.balance > appellantLocked.balance);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('every finalized block exposes explicit protocol finality fields and verifiable quorum certificates', async () => {
  const storageDir = await createTempStorage('streamchain-protocol-finality-');

  try {
    useStorage(storageDir);

    const alice = await createWallet({ username: 'alice-finality' });
    const bob = await createWallet({ username: 'bob-finality' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'formal-finality-check',
    });

    const state = await getPublicNodeState();
    const walletIndex = new Map(state.wallets.map((wallet) => [wallet.address, wallet]));

    assert.equal(state.chainConsensus.protocol, 'streamchain-hotstuff-lite');
    assert.ok(state.chainConsensus.lastFinalizedBlockHash);
    assert.ok(Array.isArray(state.chainConsensus.validatorRegistry));
    assert.ok(state.chain.every((block, index) => block.height === index));
    assert.ok(state.chain.every((block) => block.finalityStatus === 'finalized'));
    assert.ok(state.chain.every((block) => block.validatorSetHash));

    for (const block of state.chain.slice(-3)) {
      assertFormalFinality(block, walletIndex, state.network.nodeSignerPublicKey);
    }
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('self-hosted persistence uses sqlite WAL with separated block log, consensus, snapshots and evidence rows', async () => {
  const storageDir = await createTempStorage('streamchain-sqlite-storage-');

  try {
    useStorage(storageDir);

    const alice = await createWallet({ username: 'alice-storage' });
    const bob = await createWallet({ username: 'bob-storage' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'sqlite-storage-check',
    });

    const state = await getPublicNodeState();
    const db = new DatabaseSync(path.join(storageDir, 'state.sqlite'));
    const journalMode = db.prepare('PRAGMA journal_mode').get();
    const blockCount = db.prepare('SELECT COUNT(*) AS count FROM block_log').get();
    const snapshotCount = db.prepare('SELECT COUNT(*) AS count FROM app_snapshots').get();
    const consensusRow = db.prepare('SELECT latest_finalized_height, latest_epoch, latest_round, latest_snapshot_hash FROM consensus_state WHERE id = 1').get();
    const storageMeta = db.prepare("SELECT value FROM storage_meta WHERE key = 'storage_engine'").get();
    db.close();

    assert.equal(String(journalMode.journal_mode).toLowerCase(), 'wal');
    assert.equal(blockCount.count, state.chain.length);
    assert.ok(snapshotCount.count >= 1);
    assert.equal(consensusRow.latest_finalized_height, state.chain.at(-1).height);
    assert.equal(consensusRow.latest_epoch, state.chainConsensus.currentEpoch);
    assert.equal(consensusRow.latest_round, state.chainConsensus.currentRound);
    assert.ok(consensusRow.latest_snapshot_hash);
    assert.equal(storageMeta.value, 'sqlite-wal');
    assert.equal(state.network.persistence, 'sqlite-wal');
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('node signer private material is kept in a separate keystore from the persisted public app snapshot', async () => {
  const storageDir = await createTempStorage('streamchain-keystore-storage-');

  try {
    useStorage(storageDir);
    await createWallet({ username: 'keystore-check' });

    const internalState = await getInternalNodeState();
    const persistedState = JSON.parse(await readFile(path.join(storageDir, 'state.json'), 'utf8'));
    const keyStore = JSON.parse(await readFile(path.join(storageDir, 'keystore.json'), 'utf8'));

    assert.ok(internalState.network.nodeSignerPrivateKey);
    assert.equal(persistedState.network.nodeSignerPrivateKey, undefined);
    assert.equal(persistedState.network.nodeSignerPublicKey, internalState.network.nodeSignerPublicKey);
    assert.equal(persistedState.network.keyManagement.type, 'local-keystore');
    assert.equal(keyStore.currentKeyId, internalState.network.nodeSignerKeyId);
    assert.equal(
      keyStore.keys.find((entry) => entry.id === keyStore.currentKeyId)?.privateKey,
      internalState.network.nodeSignerPrivateKey,
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('restart recovery rebuilds public state deterministically from sqlite snapshots and block log', async () => {
  const storageDir = await createTempStorage('streamchain-recovery-');

  try {
    useStorage(storageDir);

    const alice = await createWallet({ username: 'alice-recovery' });
    const bob = await createWallet({ username: 'bob-recovery' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'recovery-check',
    });

    const beforeRestart = await getPublicNodeState();
    const afterRestart = await getPublicNodeState();

    assert.deepEqual(
      afterRestart.chain.map((block) => block.hash),
      beforeRestart.chain.map((block) => block.hash),
    );
    assert.deepEqual(
      afterRestart.wallets.map((wallet) => ({ address: wallet.address, balance: wallet.balance })),
      beforeRestart.wallets.map((wallet) => ({ address: wallet.address, balance: wallet.balance })),
    );
    assert.equal(afterRestart.chainConsensus.lastFinalizedBlockHash, beforeRestart.chainConsensus.lastFinalizedBlockHash);
    assert.equal(afterRestart.network.persistence, 'sqlite-wal');
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('remote sync rejects a longer divergent fork when consensus finality evidence is missing or invalid', async () => {
  const storageDir = await createTempStorage('streamchain-chain-trust-');

  try {
    useStorage(storageDir);

    const alice = await createWallet({ username: 'alice-fork' });
    const bob = await createWallet({ username: 'bob-fork' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'canonical-transfer',
    });

    const localState = await getPublicNodeState();
    const internalState = await getInternalNodeState();
    const signerPrivateKey = internalState.network.nodeSignerPrivateKey;
    const divergentChain = structuredClone(localState.chain);
    divergentChain[1] = {
      ...divergentChain[1],
      summary: 'malicious rewritten wallet block',
      hash: computeBlockHash({
        ...divergentChain[1],
        summary: 'malicious rewritten wallet block',
      }, divergentChain[0].hash),
    };
    divergentChain[1].signature = signBlockPayload(divergentChain[1], signerPrivateKey);
    for (let index = 2; index < divergentChain.length; index += 1) {
      const previous = divergentChain[index - 1];
      divergentChain[index] = {
        ...divergentChain[index],
        prevHash: previous.hash,
        hash: computeBlockHash({
          ...divergentChain[index],
          prevHash: previous.hash,
        }, previous.hash),
      };
      divergentChain[index].signature = signBlockPayload(divergentChain[index], signerPrivateKey);
    }
    const previous = divergentChain.at(-1);
    const forkBlock = {
      id: String(divergentChain.length),
      prevHash: previous.hash,
      timestamp: '2026-03-21T12:00:00.000Z',
      type: 'transaction',
      uploader: 'mallory',
      validator: 'mallory',
      mediaUrl: '',
      summary: 'extra fork block',
      signerPublicKey: localState.network.nodeSignerPublicKey,
      hash: computeBlockHash({
        id: String(divergentChain.length),
        prevHash: previous.hash,
        timestamp: '2026-03-21T12:00:00.000Z',
        type: 'transaction',
        uploader: 'mallory',
        validator: 'mallory',
        mediaUrl: '',
        summary: 'extra fork block',
      }, previous.hash),
    };
    forkBlock.signature = signBlockPayload(forkBlock, signerPrivateKey);
    divergentChain.push(forkBlock);

    await assert.rejects(
      ingestRemoteState({
        state: {
          ...localState,
          chain: divergentChain.map((block) => ({
            ...block,
            proposalCertificate: null,
            quorumCertificate: null,
            finalityStatus: 'proposed',
          })),
        },
      }),
      /finality verificable/i,
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('trusted signer rotations are held in pending state and do not replace the pinned signer automatically', async () => {
  const storageDir = await createTempStorage('streamchain-signer-rotation-');

  try {
    useStorage(storageDir);
    process.env.STREAMCHAIN_PUBLIC_URL = 'https://local.example.com';

    const alice = await createWallet({ username: 'alice-rotation' });
    const bob = await createWallet({ username: 'bob-rotation' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'seed-trust',
    });

    const trustedRemoteSigner = {
      publicKey: 'trusted-signer-key',
      privateKey: 'trusted-private-key-unused',
    };
    const localState = await getPublicNodeState();
    const seededRemote = {
      ...localState,
      network: {
        ...localState.network,
        publicUrl: 'https://trusted-peer.example.com',
        nodeSignerPublicKey: trustedRemoteSigner.publicKey,
      },
    };

    let merged = await ingestRemoteState({ state: seededRemote });
    let trustedEntry = merged.trustedPeerSigners.find((entry) => entry.url === 'https://trusted-peer.example.com');
    assert.equal(trustedEntry.trustStatus, 'trusted');
    assert.equal(trustedEntry.signerPublicKey, trustedRemoteSigner.publicKey);

    const rotatedRemote = {
      ...seededRemote,
      network: {
        ...seededRemote.network,
        nodeSignerPublicKey: 'rotated-signer-key',
      },
    };

    merged = await ingestRemoteState({ state: rotatedRemote });
    trustedEntry = merged.trustedPeerSigners.find((entry) => entry.url === 'https://trusted-peer.example.com');
    const peerEntry = merged.peerRegistry.find((entry) => entry.url === 'https://trusted-peer.example.com');

    assert.equal(trustedEntry.trustStatus, 'rotation-pending');
    assert.equal(trustedEntry.signerPublicKey, trustedRemoteSigner.publicKey);
    assert.equal(trustedEntry.pendingSignerPublicKey, 'rotated-signer-key');
    assert.equal(peerEntry.syncStatus, 'rotation-pending');

    merged = await reviewPeerSignerRotation({
      url: 'https://trusted-peer.example.com',
      reviewerAddress: alice.wallet.address,
      reviewerSecret: alice.secret,
      approve: true,
    }).then((payload) => payload.state);
    trustedEntry = merged.trustedPeerSigners.find((entry) => entry.url === 'https://trusted-peer.example.com');

    assert.equal(trustedEntry.trustStatus, 'trusted');
    assert.equal(trustedEntry.signerPublicKey, 'rotated-signer-key');
    assert.equal(trustedEntry.pendingSignerPublicKey, null);

    const auditTrail = await getAdminAuditTrail();
    assert.equal(auditTrail[0].action, 'peer_rotation_approved');
    assert.equal(auditTrail[0].targetId, 'https://trusted-peer.example.com');
  } finally {
    delete process.env.STREAMCHAIN_PUBLIC_URL;
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('revoked peers are removed from sync trust and future remote ingests are rejected', async () => {
  const storageDir = await createTempStorage('streamchain-peer-revoke-');

  try {
    useStorage(storageDir);
    process.env.STREAMCHAIN_PUBLIC_URL = 'https://local-revoke.example.com';

    const alice = await createWallet({ username: 'alice-revoke' });
    const bob = await createWallet({ username: 'bob-revoke' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'seed-revoke',
    });

    const localState = await getPublicNodeState();
    const remoteState = {
      ...localState,
      network: {
        ...localState.network,
        publicUrl: 'https://revoked-peer.example.com',
        nodeSignerPublicKey: 'revoked-peer-signer',
      },
    };

    let merged = await ingestRemoteState({ state: remoteState });
    assert.equal(merged.trustedPeerSigners.find((entry) => entry.url === 'https://revoked-peer.example.com')?.trustStatus, 'trusted');

    merged = await revokePeerTrust({
      url: 'https://revoked-peer.example.com',
      reviewerAddress: alice.wallet.address,
      reviewerSecret: alice.secret,
      reason: 'manual incident response',
    }).then((payload) => payload.state);

    const trustedEntry = merged.trustedPeerSigners.find((entry) => entry.url === 'https://revoked-peer.example.com');
    const peerEntry = merged.peerRegistry.find((entry) => entry.url === 'https://revoked-peer.example.com');
    assert.equal(trustedEntry.trustStatus, 'revoked');
    assert.equal(peerEntry.syncStatus, 'revoked');
    assert.equal(merged.peers.includes('https://revoked-peer.example.com'), false);

    await assert.rejects(
      () => ingestRemoteState({ state: remoteState }),
      /revocado/
    );

    const auditTrail = await getAdminAuditTrail();
    assert.equal(auditTrail[0].action, 'peer_revoked');
    assert.equal(auditTrail[0].targetId, 'https://revoked-peer.example.com');
  } finally {
    delete process.env.STREAMCHAIN_PUBLIC_URL;
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('linked protocol-verified peers count toward head quorum even before the local trust store is curated', async () => {
  const storageDir = await createTempStorage('streamchain-protocol-peers-');

  try {
    useStorage(storageDir);
    process.env.STREAMCHAIN_PUBLIC_URL = 'https://local-protocol.example.com';
    const now = Date.now();
    const freshObservedAtA = new Date(now).toISOString();
    const freshObservedAtB = new Date(now + 60_000).toISOString();
    const staleObservedAt = new Date(now - (1000 * 60 * 60 * 2)).toISOString();

    const alice = await createWallet({ username: 'alice-protocol' });
    const bob = await createWallet({ username: 'bob-protocol' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'seed-protocol-peers',
    });

    const internalState = await getInternalNodeState();
    internalState.consensus.currentEpoch = 4;
    internalState.peerRegistry = [];
    internalState.trustedPeerSigners = [];
    internalState.consensus.peerAnnouncements = [
      createSignedPeerAnnouncement({
        url: 'https://peer-a.example.com',
        signerPublicKey: internalState.network.nodeSignerPublicKey,
        signerPrivateKey: internalState.network.nodeSignerPrivateKey,
        epoch: internalState.consensus.currentEpoch,
        observedAt: freshObservedAtA,
      }),
      createSignedPeerAnnouncement({
        url: 'https://peer-b.example.com',
        signerPublicKey: internalState.network.nodeSignerPublicKey,
        signerPrivateKey: internalState.network.nodeSignerPrivateKey,
        epoch: internalState.consensus.currentEpoch,
        observedAt: freshObservedAtB,
      }),
      createSignedPeerAnnouncement({
        url: 'https://stale-peer.example.com',
        signerPublicKey: internalState.network.nodeSignerPublicKey,
        signerPrivateKey: internalState.network.nodeSignerPrivateKey,
        epoch: Math.max(1, internalState.consensus.currentEpoch - 3),
        observedAt: staleObservedAt,
      }),
    ];
    await replaceInternalNodeState(internalState);

    const state = await getPublicNodeState();
    assert.equal(state.chainConsensus.protocolPeerCount, 2);
    assert.equal(state.chainConsensus.trustedPeerCount, 0);
    assert.equal(state.chainConsensus.requiredHeadQuorum, 2);
  } finally {
    delete process.env.STREAMCHAIN_PUBLIC_URL;
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('longer remote chains must present verifiable finality evidence before trusted head quorum is considered', async () => {
  const storageDir = await createTempStorage('streamchain-head-quorum-');

  try {
    useStorage(storageDir);
    process.env.STREAMCHAIN_PUBLIC_URL = 'https://local-quorum.example.com';

    const alice = await createWallet({ username: 'alice-quorum' });
    const bob = await createWallet({ username: 'bob-quorum' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'seed-quorum',
    });

    const internalState = await getInternalNodeState();
    const localState = await getPublicNodeState();
    internalState.peerRegistry = [
      {
        url: 'https://peer-a.example.com',
        role: 'self-hosted-full-node',
        signerPublicKey: internalState.network.nodeSignerPublicKey,
        linkStatus: 'linked',
        syncStatus: 'synchronized',
        syncCapable: true,
      },
      {
        url: 'https://peer-b.example.com',
        role: 'self-hosted-full-node',
        signerPublicKey: internalState.network.nodeSignerPublicKey,
        linkStatus: 'linked',
        syncStatus: 'synchronized',
        syncCapable: true,
      },
    ];
    internalState.trustedPeerSigners = [
      {
        url: 'https://peer-a.example.com',
        signerPublicKey: internalState.network.nodeSignerPublicKey,
        signerHistory: [internalState.network.nodeSignerPublicKey],
        pendingSignerPublicKey: null,
        trustStatus: 'trusted',
      },
      {
        url: 'https://peer-b.example.com',
        signerPublicKey: internalState.network.nodeSignerPublicKey,
        signerHistory: [internalState.network.nodeSignerPublicKey],
        pendingSignerPublicKey: null,
        trustStatus: 'trusted',
      },
    ];
    internalState.chainObservations = [];
    await replaceInternalNodeState(internalState);

    const previous = localState.chain.at(-1);
    const payload = {
      id: String(localState.chain.length),
      prevHash: previous.hash,
      timestamp: '2026-03-21T13:00:00.000Z',
      type: 'transaction',
      uploader: 'peer-a',
      validator: 'peer-a',
      mediaUrl: '',
      summary: 'quorum-required-extension',
    };
    const nextBlock = {
      ...payload,
      hash: computeBlockHash(payload, previous.hash),
      signerPublicKey: internalState.network.nodeSignerPublicKey,
    };
    nextBlock.signature = signBlockPayload(nextBlock, internalState.network.nodeSignerPrivateKey);

    await assert.rejects(
      ingestRemoteState({
        state: {
          ...localState,
          network: {
            ...localState.network,
            publicUrl: 'https://peer-a.example.com',
            nodeSignerPublicKey: internalState.network.nodeSignerPublicKey,
          },
          chain: [...localState.chain, nextBlock],
        },
      }),
      /finality verificable/i,
    );

    const state = await getPublicNodeState();
    assert.equal(state.chainConsensus.requiredHeadQuorum, 2);
  } finally {
    delete process.env.STREAMCHAIN_PUBLIC_URL;
    await rm(storageDir, { recursive: true, force: true });
  }
});
