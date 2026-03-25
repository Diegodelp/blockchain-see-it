import fs from 'fs/promises';
import path from 'path';

import {
  attachNodeSignerToState,
  ensureNodeSignerKeyStore,
  stripNodeSignerPrivateMaterial,
} from '@/lib/self-hosted/key-store';

const LEGACY_STATE_FILE = 'state.json';
const STATE_DB_FILE = 'state.sqlite';
const MEDIA_DIR = 'media';
const APP_SNAPSHOT_INTERVAL = 1;
const DEFAULT_CHAIN_HEAD_QUORUM = 2;
const INITIAL_VALIDATOR_BOND = 5;

export function createPersistenceApi(ctx) {
  const {
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
  } = ctx;

  async function ensureStorage() {
    const storageDir = getStorageDir();
    const mediaDir = path.join(storageDir, MEDIA_DIR);
    await fs.mkdir(mediaDir, { recursive: true });
    const dbPath = path.join(storageDir, STATE_DB_FILE);
    const legacyStatePath = path.join(storageDir, LEGACY_STATE_FILE);
    return { storageDir, mediaDir, dbPath, legacyStatePath };
  }

  async function readState() {
    const { storageDir, legacyStatePath } = await ensureStorage();
    const keyStoreDir = getKeyStoreDir();
    const db = openStorageDatabase(storageDir);
    const snapshotCount = Number(db.prepare('SELECT COUNT(*) AS count FROM app_snapshots').get().count || 0);

    if (snapshotCount === 0) {
      let bootstrapState = null;
      try {
        const content = await fs.readFile(legacyStatePath, 'utf8');
        bootstrapState = prepareStateForPersistence(JSON.parse(content));
      } catch {
        bootstrapState = createInitialState();
      }

      const signer = await ensureNodeSignerKeyStore({
        storageDir,
        keyStoreDir,
        state: bootstrapState,
        createWalletKeypair,
        configuredNodeSigner: getConfiguredNodeSigner(),
        derivePublicKey: getPublicKeyFromPrivateKey,
      });
      attachNodeSignerToState(bootstrapState, signer);
      await writeState(bootstrapState);
      return readState();
    }

    const persistedBlocks = loadPersistedBlocks(db);
    const latestSnapshotRecord = db.prepare(`
      SELECT height, state_hash, signature, state_json, created_at
      FROM app_snapshots
      ORDER BY height DESC
      LIMIT 1
    `).get();
    const consensusRow = db.prepare(`
      SELECT latest_finalized_height, latest_round, latest_epoch, locked_qc_json, local_vote_state_json,
             validator_set_hash, latest_snapshot_height, latest_snapshot_hash, latest_snapshot_signature
      FROM consensus_state
      WHERE id = 1
    `).get();
    const evidenceRows = db.prepare('SELECT category, payload_json FROM evidence_store ORDER BY created_at DESC').all();
    db.close();

    const snapshotPayload = latestSnapshotRecord ? JSON.parse(latestSnapshotRecord.state_json) : extractAppSnapshot(createInitialState());
    const state = applyAppSnapshot(createInitialState(), snapshotPayload);
    state.chain = persistedBlocks;
    ensureConsensusState(state);
    if (consensusRow) {
      state.consensus.currentEpoch = Number(consensusRow.latest_epoch || state.consensus.currentEpoch || 1);
      state.consensus.currentRound = Number(consensusRow.latest_round || state.consensus.currentRound || 0);
      state.consensus.validatorSetHash = consensusRow.validator_set_hash || state.consensus.validatorSetHash || null;
      state.consensus.lastFinalizedBlockHash = state.chain?.at?.(-1)?.hash || null;
      state.consensus.lockedQC = consensusRow.locked_qc_json ? JSON.parse(consensusRow.locked_qc_json) : null;
      state.consensus.localVoteState = consensusRow.local_vote_state_json ? JSON.parse(consensusRow.local_vote_state_json) : null;
      state.consensus.latestSnapshotHeight = Number(consensusRow.latest_snapshot_height ?? latestSnapshotRecord?.height ?? -1);
      state.consensus.latestSnapshotHash = consensusRow.latest_snapshot_hash || latestSnapshotRecord?.state_hash || null;
      state.consensus.latestSnapshotSignature = consensusRow.latest_snapshot_signature || latestSnapshotRecord?.signature || null;
    }
    state.consensus.evidence = evidenceRows.filter((row) => row.category === 'consensus-evidence').map((row) => JSON.parse(row.payload_json));
    state.consensus.slashingEvents = evidenceRows.filter((row) => row.category === 'slashing-event').map((row) => JSON.parse(row.payload_json));
    state.moderationCases = evidenceRows.filter((row) => row.category === 'moderation-case').map((row) => JSON.parse(row.payload_json));

    const signer = await ensureNodeSignerKeyStore({
      storageDir,
      keyStoreDir,
      state,
      createWalletKeypair,
      configuredNodeSigner: getConfiguredNodeSigner(),
      derivePublicKey: getPublicKeyFromPrivateKey,
    });
    attachNodeSignerToState(state, signer);

    let shouldPersistMigration = false;
    if (!state.economics) {
      state.economics = {
        ...getFeeConfig(),
        treasuryBalance: 0,
        royaltyEnabled: true,
        updatedAt: new Date().toISOString(),
      };
      shouldPersistMigration = true;
    }
    if (!Array.isArray(state.listings)) {
      state.listings = [];
      shouldPersistMigration = true;
    }
    if (!state.network) {
      state.network = createInitialState().network;
      shouldPersistMigration = true;
    }
    if (!('publicUrl' in state.network)) {
      state.network.publicUrl = null;
      shouldPersistMigration = true;
    }
    if (!('node0Registration' in state.network)) {
      state.network.node0Registration = null;
      shouldPersistMigration = true;
    }
    if (!Array.isArray(state.peerRegistry)) {
      state.peerRegistry = (state.peers || []).map((peer) => ({
        url: peer,
        role: 'self-hosted-full-node',
        linkStatus: 'linked',
        syncStatus: 'synchronized',
        syncCapable: true,
        lastCheckedAt: null,
        lastSyncedAt: null,
        lastBlockHash: null,
        note: 'Migrated from legacy peer list.',
      }));
      shouldPersistMigration = true;
    }
    if (!Array.isArray(state.trustedPeerSigners)) {
      state.trustedPeerSigners = (state.peerRegistry || [])
        .filter((peer) => peer.signerPublicKey)
        .map((peer) => normalizeTrustedSignerEntry({
          url: peer.url,
          signerPublicKey: peer.signerPublicKey,
          signerHistory: [peer.signerPublicKey],
          pendingSignerPublicKey: null,
          revokedSignerPublicKeys: [],
          trustStatus: 'trusted',
          firstTrustedAt: peer.lastCheckedAt || null,
          lastValidatedAt: peer.lastCheckedAt || null,
          lastRotationDetectedAt: null,
          revokedAt: null,
          revocationReason: null,
        }));
      shouldPersistMigration = true;
    }
    state.trustedPeerSigners = (state.trustedPeerSigners || []).map((entry) => normalizeTrustedSignerEntry(entry));
    if (!Array.isArray(state.chainObservations)) {
      state.chainObservations = [];
      shouldPersistMigration = true;
    }
    state.chainObservations = (state.chainObservations || []).map((entry) => normalizeChainObservationEntry(entry));
    if (!Array.isArray(state.chainHeadEndorsements)) {
      state.chainHeadEndorsements = [];
      shouldPersistMigration = true;
    }
    state.chainHeadEndorsements = (state.chainHeadEndorsements || []).map((entry) => normalizeHeadEndorsement(entry));
    if (!Array.isArray(state.adminActionLog)) {
      state.adminActionLog = [];
      shouldPersistMigration = true;
    }
    state.adminActionLog = (state.adminActionLog || []).map((entry) => normalizeAdminActionEntry(entry));
    if (!Array.isArray(state.validatorAttestations)) {
      state.validatorAttestations = [];
      shouldPersistMigration = true;
    }
    if (!Array.isArray(state.moderationCases)) {
      state.moderationCases = [];
      shouldPersistMigration = true;
    }
    ensureConsensusState(state);
    syncConsensusValidatorRegistry(state);
    if (!Array.isArray(state.consensus.voteJournal)) {
      state.consensus.voteJournal = [];
      shouldPersistMigration = true;
    }
    if (!state.network.requiredHeadQuorum) {
      state.network.requiredHeadQuorum = DEFAULT_CHAIN_HEAD_QUORUM;
      shouldPersistMigration = true;
    }
    if (!isValidChain(state.chain || [])) {
      state.chain = normalizeChain(state.chain || []);
      shouldPersistMigration = true;
    }
    for (const wallet of state.wallets || []) {
      if (!Number.isFinite(Number(wallet.stakeBalance))) {
        wallet.stakeBalance = INITIAL_VALIDATOR_BOND;
        wallet.validatorBondedAt = wallet.createdAt || new Date().toISOString();
        shouldPersistMigration = true;
      }
      const previousProfile = stableStringify(sanitizeValidatorProfile(wallet.validatorProfile));
      if (!wallet.validatorProfile?.humanIdentityCommitment) {
        wallet.validatorProfile = sanitizeValidatorProfile({
          ...wallet.validatorProfile,
          humanIdentityCommitment: wallet.validatorProfile?.humanIdentityCommitment || wallet.address,
        });
        shouldPersistMigration = true;
      }
      recomputeValidatorProfile(state, wallet);
      if (!wallet.consensusPublicKey && wallet.publicKey) {
        wallet.consensusPublicKey = wallet.publicKey;
        shouldPersistMigration = true;
      }
      const previousNonce = wallet.nextNonce;
      const nextNonce = ensureWalletNonce(state, wallet);
      if (previousNonce !== nextNonce) {
        wallet.nextNonce = nextNonce;
        shouldPersistMigration = true;
      }
      if (previousProfile !== stableStringify(sanitizeValidatorProfile(wallet.validatorProfile))) {
        shouldPersistMigration = true;
      }
    }
    syncConsensusValidatorRegistry(state);

    const requiresFormalConsensusMigration = (state.chain || []).some((block, index) => (
      !Number.isInteger(block?.height) ||
      !Number.isInteger(block?.round) ||
      !Number.isInteger(block?.epoch) ||
      (block?.parentHash ?? null) !== (index === 0 ? null : state.chain[index - 1]?.hash ?? null) ||
      !block?.validatorSetHash ||
      !block?.quorumCertificate ||
      block?.finalityStatus !== 'finalized'
    ));
    if (requiresFormalConsensusMigration) {
      rebuildChainWithFormalFinality(state, state.chain || []);
      shouldPersistMigration = true;
    }
    state.consensus.lastFinalizedBlockHash = state.chain?.at?.(-1)?.hash || null;
    if (latestSnapshotRecord && state.network?.nodeSignerPublicKey) {
      const snapshotValid = verifySnapshotRecord(latestSnapshotRecord, state.network.nodeSignerPublicKey);
      if (!snapshotValid) {
        shouldPersistMigration = true;
      }
    }
    if (shouldPersistMigration) {
      await writeState(state);
    }
    return state;
  }

  async function writeState(state) {
    const { storageDir } = await ensureStorage();
    const signer = await ensureNodeSignerKeyStore({
      storageDir,
      keyStoreDir: getKeyStoreDir(),
      state,
      createWalletKeypair,
      configuredNodeSigner: getConfiguredNodeSigner(),
      derivePublicKey: getPublicKeyFromPrivateKey,
    });
    attachNodeSignerToState(state, signer);
    state = prepareStateForPersistence(state);
    const publicPersistedState = stripNodeSignerPrivateMaterial(state);

    const db = openStorageDatabase(storageDir);
    const latestBlock = state.chain?.at?.(-1) || null;
    const latestHeight = Number(latestBlock?.height ?? -1);
    const latestRound = Number(state.consensus?.currentRound || latestBlock?.round || 0);
    const latestEpoch = Number(state.consensus?.currentEpoch || latestBlock?.epoch || 1);
    const appSnapshot = extractAppSnapshot(publicPersistedState);
    const appStateHash = sha256(stableStringify(appSnapshot));
    const snapshotSignature = signer?.privateKey
      ? signConsensusPayload(createSnapshotSignaturePayload(latestHeight, appStateHash), signer.privateKey)
      : null;
    const snapshotEveryWrite = latestHeight < 0 || latestHeight % APP_SNAPSHOT_INTERVAL === 0;
    const lockedQC = latestBlock?.quorumCertificate || null;
    const localVoteState = (state.consensus?.voteJournal || []).at?.(0) || null;
    const evidenceEntries = extractEvidenceEntries(state);

    db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const selectBlock = db.prepare('SELECT hash FROM block_log WHERE height = ?');
      const insertBlock = db.prepare(`
        INSERT INTO block_log (height, hash, parent_hash, epoch, round, finality_status, app_state_hash, block_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const block of state.chain || []) {
        const existing = selectBlock.get(block.height);
        if (existing) {
          if (existing.hash !== block.hash) {
            throw new Error(`Append-only block log conflict at height ${block.height}.`);
          }
          continue;
        }

        insertBlock.run(
          block.height,
          block.hash,
          block.parentHash ?? block.prevHash ?? null,
          Number(block.epoch || 0),
          Number(block.round || 0),
          block.finalityStatus || 'finalized',
          appStateHash,
          JSON.stringify(block),
          block.timestamp || new Date().toISOString(),
        );
      }

      if (snapshotEveryWrite) {
        db.prepare(`
          INSERT INTO app_snapshots (height, state_hash, signature, state_json, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(height) DO UPDATE SET
            state_hash = excluded.state_hash,
            signature = excluded.signature,
            state_json = excluded.state_json,
            created_at = excluded.created_at
        `).run(
          latestHeight,
          appStateHash,
          snapshotSignature,
          JSON.stringify(appSnapshot),
          new Date().toISOString(),
        );
      }

      db.prepare(`
        INSERT INTO consensus_state (
          id, latest_finalized_height, latest_round, latest_epoch, locked_qc_json, local_vote_state_json,
          validator_set_hash, latest_snapshot_height, latest_snapshot_hash, latest_snapshot_signature, updated_at
        )
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          latest_finalized_height = excluded.latest_finalized_height,
          latest_round = excluded.latest_round,
          latest_epoch = excluded.latest_epoch,
          locked_qc_json = excluded.locked_qc_json,
          local_vote_state_json = excluded.local_vote_state_json,
          validator_set_hash = excluded.validator_set_hash,
          latest_snapshot_height = excluded.latest_snapshot_height,
          latest_snapshot_hash = excluded.latest_snapshot_hash,
          latest_snapshot_signature = excluded.latest_snapshot_signature,
          updated_at = excluded.updated_at
      `).run(
        latestHeight,
        latestRound,
        latestEpoch,
        lockedQC ? JSON.stringify(lockedQC) : null,
        localVoteState ? JSON.stringify(localVoteState) : null,
        state.consensus?.validatorSetHash || null,
        latestHeight,
        appStateHash,
        snapshotSignature,
        new Date().toISOString(),
      );

      db.prepare('DELETE FROM evidence_store').run();
      const insertEvidence = db.prepare(`
        INSERT INTO evidence_store (id, category, ref_height, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const entry of evidenceEntries) {
        insertEvidence.run(
          entry.id,
          entry.category,
          Number(entry.refHeight || 0),
          JSON.stringify(entry.payload),
          entry.payload?.recordedAt || entry.payload?.timestamp || entry.payload?.finalizedAt || new Date().toISOString(),
        );
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
    db.close();

    if (typeof writeLegacyCompatibleState === 'function') {
      await writeLegacyCompatibleState(storageDir, publicPersistedState).catch(() => null);
    }
  }

  return {
    ensureStorage,
    readState,
    writeState,
    async getInternalNodeState() {
      return readState();
    },
    async replaceInternalNodeState(nextState) {
      await writeState(nextState);
      return readState();
    },
  };
}
