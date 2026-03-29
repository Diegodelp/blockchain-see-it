import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GET as bootstrapGET } from '../app/api/bootstrap/route.js';
import { GET as chainGET } from '../app/api/chain/route.js';
import { GET as manifestGET } from '../app/api/manifest/route.js';
import { POST as registerPOST } from '../app/api/node0/register/route.js';
import { computeBlockHash, signBlockPayload, signConsensusPayload } from '../lib/chain-security.js';
import { getLiveNode0State } from '../lib/node0.js';
import { readRegisteredPeers, upsertRegisteredPeer } from '../lib/node0-registry.js';
import { createWalletKeypair } from '../lib/transaction-security.js';

const CONTACT_ENV_KEYS = [
  'STREAMCHAIN_CONTACT_HEADLINE',
  'STREAMCHAIN_CONTACT_SUPPORT_EMAIL',
  'STREAMCHAIN_CONTACT_BUSINESS_EMAIL',
  'STREAMCHAIN_CONTACT_DOCS_URL',
  'STREAMCHAIN_CONTACT_SUPPORT_URL',
  'STREAMCHAIN_CONTACT_PARTNERSHIP_URL',
  'STREAMCHAIN_CONTACT_DISCORD_URL',
  'STREAMCHAIN_CONTACT_TELEGRAM_URL',
  'STREAMCHAIN_CONTACT_CALENDLY_URL',
  'STREAMCHAIN_CONTACT_RESPONSE_SLA',
  'STREAMCHAIN_CONTACT_TIMEZONE',
];

function createValidChain(length = 1, signer) {
  const chain = [];

  for (let index = 0; index < length; index += 1) {
    const previous = chain[index - 1];
    const block = {
      id: String(index),
      prevHash: index === 0 ? null : previous.hash,
      timestamp: `2026-03-2${index}T00:00:00.000Z`,
      type: index === 0 ? 'genesis' : 'listing',
      uploader: index === 0 ? 'network' : 'peer-user',
      validator: index === 0 ? 'node0' : 'marketplace',
      mediaUrl: '',
      summary: `block-${index}`,
    };

    const nextBlock = {
      ...block,
      hash: computeBlockHash(block),
      signerPublicKey: signer.publicKey,
    };
    nextBlock.signature = signBlockPayload(nextBlock, signer.privateKey);
    chain.push(nextBlock);
  }

  return chain;
}

function createPeerState({ listingId = 'peer-listing-1', purchaseCount = 2, chainLength = 3 } = {}) {
  const signer = createWalletKeypair();
  const chain = createValidChain(chainLength, signer);
  const peerAnnouncement = {
    url: 'https://peer-valid.example.com',
    signerPublicKey: signer.publicKey,
    epoch: 3,
    observedAt: '2026-03-21T00:00:00.000Z',
    ttlMs: 1000 * 60 * 30,
    expiresAt: '2026-03-21T00:30:00.000Z',
    validatorSetHash: null,
    headHash: chain.at(-1)?.hash || null,
    source: 'self-announced-peer',
  };
  peerAnnouncement.signature = signConsensusPayload({
    url: peerAnnouncement.url,
    signerPublicKey: peerAnnouncement.signerPublicKey,
    epoch: peerAnnouncement.epoch,
    observedAt: peerAnnouncement.observedAt,
    ttlMs: peerAnnouncement.ttlMs,
    expiresAt: peerAnnouncement.expiresAt,
    validatorSetHash: peerAnnouncement.validatorSetHash,
    headHash: peerAnnouncement.headHash,
  }, signer.privateKey);
  return {
    network: { role: 'self-hosted-full-node', nodeSignerPublicKey: signer.publicKey },
    manifest: { capabilities: ['wallet creation'], monetization: ['marketplace'] },
    economics: { treasuryBalance: 7, transactionFeeRate: 0.01, marketplaceFeeRate: 0.05, creatorRoyaltyRate: 0.1, royaltyEnabled: true, updatedAt: '2026-03-21T00:00:00.000Z' },
    chain,
    featuredVideos: [
      {
        proof: 'peer-proof-1',
        title: 'peer-video',
        creatorAddress: 'creator-1',
        ownerAddress: 'owner-1',
        owner: 'owner-1',
        url: 'https://example.com/peer-video.mp4',
      },
    ],
    rejectedVideos: [],
    wallets: [],
    pendingVideos: [],
    transactions: [],
    peers: [],
    peerRegistry: [],
    listings: [
      {
        id: listingId,
        title: 'peer listing',
        videoProof: 'peer-proof-1',
        sellerName: 'seller-1',
        creatorName: 'creator-1',
        amount: 9,
        currency: 'SCH',
        purchaseCount,
        status: 'active',
        createdAt: '2026-03-21T00:00:00.000Z',
        purchaseHistory: [],
      },
    ],
    metrics: { resaleSales: 0, soldListings: 0, marketplaceVolume: 9 },
    chainConsensus: {
      protocol: 'streamchain-bft-v1',
      currentEpoch: 3,
      currentRound: 7,
      validatorSetHash: 'validator-set-hash-demo',
      validatorRegistry: [
        {
          validatorAddress: 'validator-1',
          consensusPublicKey: signer.publicKey,
          stakeBalance: 100,
          status: 'active',
        },
      ],
      epochChanges: [{ epoch: 3, validatorSetHash: 'validator-set-hash-demo' }],
      peerAnnouncements: [peerAnnouncement],
      lastFinalizedBlockHash: chain.at(-1)?.hash || null,
      evidence: [],
      slashingEvents: [],
    },
  };
}

async function withMockedNode0Fetch(mapping, fn) {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const key = String(url);
    if (!(key in mapping)) {
      throw new Error(`Unexpected fetch: ${key}`);
    }

    const value = mapping[key];
    if (value instanceof Error) {
      throw value;
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return value;
      },
    };
  };

  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

test('node0 live state only trusts peers with valid chains and merges updated listing data', async () => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-node0-registry-'));
  delete globalThis.__streamchainNode0Registry;
  process.env.STREAMCHAIN_NODE_MODE = 'node0';
  process.env.STREAMCHAIN_NODE0_PEERS = 'https://peer-valid.example.com,https://peer-invalid.example.com';
  process.env.STREAMCHAIN_NODE0_REGISTRY_DIR = registryDir;

  const validPeerState = createPeerState({ listingId: 'demo-listing-1', purchaseCount: 9, chainLength: 5 });
  const invalidPeerState = {
    ...createPeerState({ listingId: 'invalid-listing', purchaseCount: 1, chainLength: 2 }),
    chain: [{ ...createPeerState({ chainLength: 1 }).chain[0], hash: 'tampered-hash' }],
  };

  try {
    const liveState = await withMockedNode0Fetch({
      'https://peer-valid.example.com/api/node/export': validPeerState,
      'https://peer-invalid.example.com/api/node/export': invalidPeerState,
    }, async () => getLiveNode0State());

    assert.equal(liveState.references.totals.onlinePeers, 1);
    assert.equal(liveState.references.peers.find((peer) => peer.url === 'https://peer-invalid.example.com').status, 'offline');
    assert.equal(liveState.listings.find((listing) => listing.id === 'demo-listing-1').purchaseCount, 9);
    assert.equal(liveState.chain.length, 5);
  } finally {
    await rm(registryDir, { recursive: true, force: true });
    delete process.env.STREAMCHAIN_NODE0_REGISTRY_DIR;
    delete process.env.STREAMCHAIN_NODE0_PEERS;
    for (const key of CONTACT_ENV_KEYS) {
      delete process.env[key];
    }
    delete globalThis.__streamchainNode0Registry;
  }
});

test('node0 public routes return aggregated readonly payloads with cache headers', async () => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-node0-routes-'));
  delete globalThis.__streamchainNode0Registry;
  process.env.STREAMCHAIN_NODE_MODE = 'node0';
  process.env.STREAMCHAIN_NODE0_PEERS = 'https://peer-valid.example.com';
  process.env.STREAMCHAIN_NODE0_REGISTRY_DIR = registryDir;
  process.env.STREAMCHAIN_CONTACT_SUPPORT_EMAIL = 'ops@streamchain.example';
  process.env.STREAMCHAIN_CONTACT_BUSINESS_EMAIL = 'partners@streamchain.example';
  process.env.STREAMCHAIN_CONTACT_DOCS_URL = 'https://docs.streamchain.example/node0';
  process.env.STREAMCHAIN_CONTACT_RESPONSE_SLA = '24h';
  process.env.STREAMCHAIN_CONTACT_TIMEZONE = 'UTC';

  const peerState = createPeerState({ listingId: 'peer-route-listing', purchaseCount: 3, chainLength: 4 });

  try {
    await withMockedNode0Fetch({
      'https://peer-valid.example.com/api/node/export': peerState,
    }, async () => {
      const bootstrapResponse = await bootstrapGET();
      const manifestResponse = await manifestGET();
      const chainResponse = await chainGET();

      const bootstrap = await bootstrapResponse.json();
      const manifest = await manifestResponse.json();
      const chain = await chainResponse.json();

      assert.equal(bootstrapResponse.headers.get('Cache-Control'), 'public, s-maxage=120, stale-while-revalidate=300');
      assert.equal(manifestResponse.headers.get('Cache-Control'), 'public, s-maxage=120, stale-while-revalidate=300');
      assert.equal(chainResponse.headers.get('Cache-Control'), 'public, s-maxage=120, stale-while-revalidate=300');
      assert.equal(bootstrap.listingCount, chain.listings.length);
      assert.equal(bootstrap.contact.supportEmail, 'ops@streamchain.example');
      assert.equal(bootstrap.discovery.mode, 'federated-discovery');
      assert.ok(bootstrap.discovery.peers.includes('https://peer-valid.example.com'));
      assert.equal(bootstrap.protocolBootstrap.currentEpoch, 3);
      assert.equal(bootstrap.protocolBootstrap.validatorSetHash, 'validator-set-hash-demo');
      assert.equal(bootstrap.protocolBootstrap.peerAnnouncements[0].url, 'https://peer-valid.example.com');
      assert.equal(manifest.contact.supportEmail, 'ops@streamchain.example');
      assert.equal(manifest.contact.docsUrl, 'https://docs.streamchain.example/node0');
      assert.ok(Array.isArray(manifest.roadmap));
      assert.equal(chain.references.totals.onlinePeers, 1);
      assert.equal(chain.listings.find((listing) => listing.id === 'peer-route-listing').purchaseCount, 3);
    });
  } finally {
    await rm(registryDir, { recursive: true, force: true });
    delete process.env.STREAMCHAIN_NODE0_REGISTRY_DIR;
    delete process.env.STREAMCHAIN_NODE0_PEERS;
    for (const key of CONTACT_ENV_KEYS) {
      delete process.env[key];
    }
    delete globalThis.__streamchainNode0Registry;
  }
});

test('node0 registration rejects requests without the configured secret', async () => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-node0-register-secret-'));
  delete globalThis.__streamchainNode0Registry;
  process.env.STREAMCHAIN_NODE_MODE = 'node0';
  process.env.STREAMCHAIN_NODE0_REGISTRY_DIR = registryDir;
  process.env.STREAMCHAIN_NODE0_REGISTRATION_SECRET = 'super-secret';

  try {
    const response = await registerPOST(new Request('http://localhost/api/node0/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://peer-valid.example.com' }),
    }));

    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.match(payload.error, /secret inválido o ausente/i);
  } finally {
    await rm(registryDir, { recursive: true, force: true });
    delete process.env.STREAMCHAIN_NODE0_REGISTRY_DIR;
    delete process.env.STREAMCHAIN_NODE0_REGISTRATION_SECRET;
    delete globalThis.__streamchainNode0Registry;
  }
});

test('node0 registry falls back to tmp storage when configured directory is not writable', async () => {
  const originalVercel = process.env.VERCEL;
  delete globalThis.__streamchainNode0Registry;
  process.env.VERCEL = '1';
  process.env.STREAMCHAIN_NODE0_REGISTRY_DIR = '/vercel';

  try {
    await upsertRegisteredPeer({
      url: 'https://peer-fallback.example.com',
      status: 'verified',
      registeredAt: new Date().toISOString(),
    });

    const peers = await readRegisteredPeers();
    assert.ok(peers.some((peer) => peer.url === 'https://peer-fallback.example.com'));
  } finally {
    if (originalVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = originalVercel;
    }
    delete process.env.STREAMCHAIN_NODE0_REGISTRY_DIR;
    delete globalThis.__streamchainNode0Registry;
  }
});
