import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPendingMedia,
  createTransaction,
  createVideoListing,
  createWallet,
  flagFeaturedMedia,
  getInternalNodeState,
  getPublicNodeState,
  ingestRemoteState,
  purchaseVideoListing,
  replaceInternalNodeState,
  validatePendingMedia,
} from '../lib/self-hosted-node.js';
import { createConsensusVotePayload, verifyConsensusSignature } from '../lib/chain-security.js';

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

function createDeterministicRng(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function choose(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

async function resolvePendingByPolicy(pending, walletsByAddress, decision = 'approve') {
  const assigned = pending.assignedValidators?.length
    ? pending.assignedValidators
    : Object.keys(walletsByAddress).filter((address) => address !== pending.uploaderAddress);
  const required = Math.min(pending.requiredValidations, assigned.length);
  let state = null;
  for (const address of assigned.slice(0, required)) {
    const actor = walletsByAddress[address];
    state = await validatePendingMedia({
      pendingId: pending.id,
      validatorAddress: actor.wallet.address,
      validatorSecret: actor.secret,
      authenticity: decision === 'approve' ? 'approve' : 'reject',
      manipulated: decision !== 'approve',
      duplicate: false,
      reasonCode: decision === 'approve' ? 'policy-other' : 'fraudulent-edit',
      notes: `auto-${decision}`,
    });
  }
  return state;
}

function assertStateInvariants(state) {
  assert.ok(state.chainConsensus.lastFinalizedBlockHash);
  assert.equal(state.chainConsensus.lastFinalizedBlockHash, state.chain.at(-1)?.hash || null);

  for (const wallet of state.wallets) {
    assert.ok(Number(wallet.balance) >= 0, `negative balance for ${wallet.address}`);
    assert.ok(Number(wallet.stakeBalance || 0) >= 0, `negative stake for ${wallet.address}`);
  }

  const featuredProofs = new Set(state.featuredVideos.map((video) => video.proof));
  for (const rejected of state.rejectedVideos || []) {
    assert.ok(!featuredProofs.has(rejected.id), `video ${rejected.id} cannot be approved and rejected simultaneously`);
  }

  for (const listing of state.listings || []) {
    if (listing.status !== 'active') {
      continue;
    }
    const video = state.featuredVideos.find((entry) => entry.proof === listing.videoProof);
    assert.ok(video, `active listing ${listing.id} must point to an approved asset`);
    assert.ok(!['challenged', 'under-review', 'restricted'].includes(video.moderationState), `challenged asset ${listing.videoProof} cannot stay on sale`);
  }

  for (const block of state.chain) {
    assert.equal(block.finalityStatus, 'finalized');
    for (const certificate of [block.proposalCertificate, block.quorumCertificate]) {
      const seen = new Set();
      for (const vote of certificate?.votes || []) {
        assert.ok(!seen.has(vote.validatorAddress), `validator ${vote.validatorAddress} voted twice in the same certificate`);
        seen.add(vote.validatorAddress);
        const payload = createConsensusVotePayload(vote);
        const snapshotEntry = certificate.validatorSnapshot.find((entry) => entry.validatorAddress === vote.validatorAddress);
        const publicKey = vote.validatorPublicKey || snapshotEntry?.consensusPublicKey || state.network.nodeSignerPublicKey;
        assert.ok(verifyConsensusSignature(payload, publicKey, vote.signature), `invalid QC vote signature for ${vote.validatorAddress}`);
      }
    }
  }
}

test('property-style randomized operations preserve core economic and moderation invariants', async () => {
  const storageDir = await createTempStorage('streamchain-prop-');
  const rng = createDeterministicRng(42);

  try {
    useStorage(storageDir);

    const actors = [];
    for (const username of ['alice', 'bob', 'carol', 'dan', 'eve', 'frank']) {
      actors.push(await createWallet({ username: `prop-${username}` }));
    }
    const walletsByAddress = Object.fromEntries(actors.map((entry) => [entry.wallet.address, entry]));

    for (let index = 0; index < 25; index += 1) {
      const roll = rng();
      const state = await getPublicNodeState();

      if (roll < 0.30) {
        const sender = choose(actors, rng);
        const receiver = choose(actors.filter((entry) => entry.wallet.address !== sender.wallet.address), rng);
        const senderPublic = state.wallets.find((wallet) => wallet.address === sender.wallet.address);
        if (senderPublic?.balance > 1.25) {
          await createTransaction({
            senderAddress: sender.wallet.address,
            senderSecret: sender.secret,
            receiverAddress: receiver.wallet.address,
            amount: 1,
            summary: `prop-tx-${index}`,
          });
        }
      } else if (roll < 0.60) {
        const uploader = choose(actors, rng);
        let nextState = await createPendingMedia({
          uploaderAddress: uploader.wallet.address,
          uploaderSecret: uploader.secret,
          title: `prop-video-${index}`,
          type: 'video',
          externalUrl: roll < 0.45 ? `https://example.com/violent-prop-${index}.mp4` : `https://example.com/calm-prop-${index}.mp4`,
        });
        const pending = nextState.pendingVideos.find((item) => item.title === `prop-video-${index}`);
        if (pending) {
          nextState = await resolvePendingByPolicy(pending, walletsByAddress, roll < 0.48 ? 'reject' : 'approve');
        }
        assert.ok(nextState);
      } else if (roll < 0.82) {
        const stateWithVideos = await getPublicNodeState();
        const candidate = choose(stateWithVideos.featuredVideos || [], rng);
        if (candidate) {
          const owner = actors.find((entry) => entry.wallet.address === candidate.ownerAddress);
          const buyer = choose(actors.filter((entry) => entry.wallet.address !== candidate.ownerAddress), rng);
          if (owner) {
            await createVideoListing({
              sellerAddress: owner.wallet.address,
              sellerSecret: owner.secret,
              videoProof: candidate.proof,
              price: 2,
              description: `prop-listing-${index}`,
            }).catch(() => null);
            const refreshed = await getPublicNodeState();
            const activeListing = refreshed.listings.find((listing) => listing.videoProof === candidate.proof && listing.status === 'active');
            if (activeListing) {
              await purchaseVideoListing({
                listingId: activeListing.id,
                buyerAddress: buyer.wallet.address,
                buyerSecret: buyer.secret,
              }).catch(() => null);
            }
          }
        }
      } else {
        const challengedState = await getPublicNodeState();
        const challengeable = challengedState.featuredVideos.find((video) => video.moderationState === 'approved-auto');
        const challenger = choose(actors, rng);
        if (challengeable) {
          let nextState = await flagFeaturedMedia({
            proof: challengeable.proof,
            challengerAddress: challenger.wallet.address,
            challengerSecret: challenger.secret,
            reasonCode: 'fraudulent-edit',
            reason: `prop-challenge-${index}`,
          }).catch(() => null);
          const pending = nextState?.pendingVideos.find((item) => item.existingVideoProof === challengeable.proof);
          if (pending) {
            nextState = await resolvePendingByPolicy(pending, walletsByAddress, 'reject');
            assert.ok(nextState);
          }
        }
      }

      assertStateInvariants(await getPublicNodeState());
    }
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('fuzzed malformed quorum certificates and block metadata are rejected before finality adoption', async () => {
  const sourceStorage = await createTempStorage('streamchain-fuzz-source-');
  const replicaStorage = await createTempStorage('streamchain-fuzz-replica-');

  try {
    useStorage(sourceStorage);
    const alice = await createWallet({ username: 'fuzz-alice' });
    const bob = await createWallet({ username: 'fuzz-bob' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'fuzz-seed',
    });
    const canonical = await getPublicNodeState();

    const mutations = [
      {
        label: 'truncated block signature',
        mutate: (state) => { state.chain.at(-1).signature = state.chain.at(-1).signature.slice(0, -8); return state; },
        assertOutcome: async (mutate) => {
          useStorage(replicaStorage);
          const beforeReplica = await getPublicNodeState();
          const merged = await ingestRemoteState({ state: mutate(structuredClone(canonical)) });
          assert.equal(merged.chain.at(-1).hash, beforeReplica.chain.at(-1).hash);
          assert.equal(merged.chain.length, beforeReplica.chain.length);
        },
      },
      {
        label: 'downgraded finality status',
        mutate: (state) => { state.chain.at(-1).finalityStatus = 'proposed'; return state; },
        assertOutcome: async (mutate) => {
          useStorage(replicaStorage);
          await assert.rejects(
            ingestRemoteState({ state: mutate(structuredClone(canonical)) }),
            /finality verificable|state remoto/i,
          );
        },
      },
      {
        label: 'broken quorum certificate vote signature',
        mutate: (state) => { state.chain.at(-1).quorumCertificate.votes[0].signature = 'broken'; return state; },
        assertOutcome: async (mutate) => {
          useStorage(replicaStorage);
          await assert.rejects(
            ingestRemoteState({ state: mutate(structuredClone(canonical)) }),
            /finality verificable|state remoto/i,
          );
        },
      },
      {
        label: 'wrong proposal validator set hash',
        mutate: (state) => { state.chain.at(-1).proposalCertificate.validatorSetHash = 'wrong-set-hash'; return state; },
        assertOutcome: async (mutate) => {
          useStorage(replicaStorage);
          await assert.rejects(
            ingestRemoteState({ state: mutate(structuredClone(canonical)) }),
            /finality verificable|state remoto/i,
          );
        },
      },
      {
        label: 'fake parent hash',
        mutate: (state) => { state.chain.at(-1).parentHash = 'fake-parent'; return state; },
        assertOutcome: async (mutate) => {
          useStorage(replicaStorage);
          await assert.rejects(
            ingestRemoteState({ state: mutate(structuredClone(canonical)) }),
            /finality verificable|state remoto/i,
          );
        },
      },
      {
        label: 'duplicate quorum certificate vote',
        mutate: (state) => { state.chain.at(-1).quorumCertificate.votes.push({ ...state.chain.at(-1).quorumCertificate.votes[0] }); return state; },
        assertOutcome: async (mutate) => {
          useStorage(replicaStorage);
          await assert.rejects(
            ingestRemoteState({ state: mutate(structuredClone(canonical)) }),
            /finality verificable|state remoto/i,
          );
        },
      },
    ];

    for (const { label, mutate, assertOutcome } of mutations) {
      await assertOutcome(mutate);
      useStorage(replicaStorage);
      const replicaState = await getPublicNodeState();
      assert.notEqual(replicaState.chain.at(-1).hash, canonical.chain.at(-1).hash, `${label} must not finalize the forged remote head on a fresh replica`);
      assertStateInvariants(replicaState);
    }
  } finally {
    await rm(sourceStorage, { recursive: true, force: true });
    await rm(replicaStorage, { recursive: true, force: true });
  }
});

test('byzantine peer heads and out-of-order honest syncs do not overturn the canonical finalized chain', async () => {
  const nodeA = await createTempStorage('streamchain-node-a-');
  const nodeB = await createTempStorage('streamchain-node-b-');
  const nodeC = await createTempStorage('streamchain-node-c-');

  try {
    useStorage(nodeA);
    const alice = await createWallet({ username: 'net-alice' });
    const bob = await createWallet({ username: 'net-bob' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'head-1',
    });
    const olderHonestState = await getPublicNodeState();

    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'head-2',
    });
    const latestHonestState = await getPublicNodeState();
    const maliciousState = structuredClone(latestHonestState);
    maliciousState.network.publicUrl = 'https://byzantine-peer.example.com';
    maliciousState.chain.at(-1).quorumCertificate.votes[0].signature = 'tampered-signature';

    useStorage(nodeB);
    const nodeBBeforeSync = await getPublicNodeState();
    await assert.rejects(
      ingestRemoteState({ state: maliciousState }),
      /finality verificable|state remoto/i,
    );
    const afterByzantineAttempt = await getPublicNodeState();
    assert.equal(afterByzantineAttempt.chain.length, nodeBBeforeSync.chain.length);
    assert.equal(afterByzantineAttempt.chain.at(-1).hash, nodeBBeforeSync.chain.at(-1).hash);

    const adoptedOnB = await ingestRemoteState({ state: latestHonestState });
    assert.equal(adoptedOnB.chain.length, nodeBBeforeSync.chain.length);
    assert.equal(adoptedOnB.chain.at(-1).hash, nodeBBeforeSync.chain.at(-1).hash);

    useStorage(nodeC);
    const nodeCBeforeSync = await getPublicNodeState();
    let nodeCState = await ingestRemoteState({ state: latestHonestState });
    assert.equal(nodeCState.chain.length, nodeCBeforeSync.chain.length);
    assert.equal(nodeCState.chain.at(-1).hash, nodeCBeforeSync.chain.at(-1).hash);
    nodeCState = await ingestRemoteState({ state: olderHonestState });
    assert.equal(nodeCState.chain.length, nodeCBeforeSync.chain.length);
    assert.equal(nodeCState.chain.at(-1).hash, nodeCBeforeSync.chain.at(-1).hash);
  } finally {
    await rm(nodeA, { recursive: true, force: true });
    await rm(nodeB, { recursive: true, force: true });
    await rm(nodeC, { recursive: true, force: true });
  }
});

test('crash-like discarded in-memory mutations never survive a restart unless they were persisted', async () => {
  const storageDir = await createTempStorage('streamchain-crash-before-persist-');

  try {
    useStorage(storageDir);
    const alice = await createWallet({ username: 'crash-alice' });
    const bob = await createWallet({ username: 'crash-bob' });
    await createTransaction({
      senderAddress: alice.wallet.address,
      senderSecret: alice.secret,
      receiverAddress: bob.wallet.address,
      amount: 1,
      summary: 'persisted-state',
    });

    const persisted = await getPublicNodeState();
    const leakedMutation = await getInternalNodeState();
    leakedMutation.wallets[0].balance = 9999;
    leakedMutation.pendingVideos.push({
      id: 'ghost-pending',
      title: 'ghost',
      uploaderAddress: alice.wallet.address,
      assignedValidators: [],
      requiredValidations: 1,
      validators: [],
      validations: [],
    });

    const afterRestart = await getPublicNodeState();
    assert.notEqual(afterRestart.wallets[0].balance, 9999);
    assert.equal(afterRestart.pendingVideos.find((item) => item.id === 'ghost-pending'), undefined);
    assert.deepEqual(
      afterRestart.chain.map((block) => block.hash),
      persisted.chain.map((block) => block.hash),
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
