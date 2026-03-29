import state from '@/data/node0-state.json';
import { isValidChain } from '@/lib/chain-security';
import { readRegisteredPeers } from '@/lib/node0-registry';
import { getPeerSeedUrls, getPublicContactInfo } from '@/lib/runtime-config';

const MAX_REFERENCE_DEPTH = 2;
const MAX_REFERENCE_NODES = 24;

function normalizePeerUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function mergeUniqueBy(list, incoming, key) {
  const map = new Map((list || []).map((item) => [item[key], item]));
  for (const item of incoming || []) {
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

export function getNode0State() {
  return {
    ...state,
    contact: getPublicContactInfo(state.contact),
  };
}

export function getConfiguredNode0PeerUrls() {
  return Array.from(new Set([
    ...String(process.env.STREAMCHAIN_NODE0_PEERS || '')
      .split(',')
      .map((item) => normalizePeerUrl(item))
      .filter(Boolean),
    ...getPeerSeedUrls().map((item) => normalizePeerUrl(item)).filter(Boolean),
  ]));
}

export async function getNode0PeerUrls() {
  const configured = getConfiguredNode0PeerUrls();
  const registered = await readRegisteredPeers().catch(() => []);
  const combined = new Set(configured);

  for (const peer of registered) {
    const normalized = normalizePeerUrl(peer.url);
    if (normalized && peer.status !== 'rejected') {
      combined.add(normalized);
    }
  }

  return Array.from(combined);
}

function assertPeerState(url, peerState) {
  const signerPublicKey = peerState?.network?.nodeSignerPublicKey || null;
  if (!signerPublicKey) {
    throw new Error(`Peer ${url} did not expose nodeSignerPublicKey.`);
  }

  if (!isValidChain(peerState?.chain || [], {
    requireSignatures: true,
    expectedSignerPublicKey: signerPublicKey,
  })) {
    throw new Error(`Peer ${url} returned an invalid chain.`);
  }

  return peerState;
}

async function fetchPeerExport(url) {
  const response = await fetch(`${url}/api/node/export`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return assertPeerState(url, await response.json());
}

function buildPeerSummary(url, peerState) {
  return {
    url,
    status: 'online',
    role: peerState.network?.role || 'self-hosted-peer',
    chainHeight: Array.isArray(peerState.chain) ? peerState.chain.length : 0,
    walletCount: Array.isArray(peerState.wallets) ? peerState.wallets.length : 0,
    listingCount: Array.isArray(peerState.listings) ? peerState.listings.length : 0,
    featuredCount: Array.isArray(peerState.featuredVideos) ? peerState.featuredVideos.length : 0,
    pendingCount: Array.isArray(peerState.pendingVideos) ? peerState.pendingVideos.length : 0,
    treasuryBalance: Number(peerState.economics?.treasuryBalance || 0),
    lastBlockHash: peerState.chain?.at?.(-1)?.hash || null,
    discoveredPeers: (peerState.peers || []).map((peer) => normalizePeerUrl(peer)).filter(Boolean),
    lastSeenAt: new Date().toISOString(),
  };
}

function buildOfflinePeerSummary(url, error) {
  return {
    url,
    status: 'offline',
    role: 'unreachable-peer',
    chainHeight: 0,
    walletCount: 0,
    listingCount: 0,
    featuredCount: 0,
    pendingCount: 0,
    treasuryBalance: 0,
    lastBlockHash: null,
    discoveredPeers: [],
    lastSeenAt: new Date().toISOString(),
    error: error.message,
  };
}

async function crawlReferenceNetwork() {
  const basePeers = await getNode0PeerUrls();
  const queue = basePeers.map((url) => ({ url, depth: 0 }));
  const visited = new Set();
  const nodes = [];

  while (queue.length > 0 && nodes.length < MAX_REFERENCE_NODES) {
    const { url, depth } = queue.shift();
    if (!url || visited.has(url)) {
      continue;
    }

    visited.add(url);

    try {
      const peerState = await fetchPeerExport(url);
      const summary = buildPeerSummary(url, peerState);
      nodes.push({ summary, peerState });

      if (depth < MAX_REFERENCE_DEPTH) {
        for (const discoveredUrl of summary.discoveredPeers) {
          if (!visited.has(discoveredUrl)) {
            queue.push({ url: discoveredUrl, depth: depth + 1 });
          }
        }
      }
    } catch (error) {
      nodes.push({ summary: buildOfflinePeerSummary(url, error), peerState: null });
    }
  }

  return nodes;
}

export async function getNode0ReferenceSnapshot() {
  const nodes = await crawlReferenceNetwork();
  const peers = nodes.map((node) => node.summary);
  const configuredPeers = await getNode0PeerUrls();

  return {
    peers,
    totals: {
      configuredPeers: configuredPeers.length,
      discoveredPeers: Math.max(0, peers.length - configuredPeers.length),
      onlinePeers: peers.filter((peer) => peer.status === 'online').length,
      aggregateChainHeight: peers.reduce((sum, peer) => sum + peer.chainHeight, 0),
      aggregateListings: peers.reduce((sum, peer) => sum + peer.listingCount, 0),
      aggregateFeatured: peers.reduce((sum, peer) => sum + peer.featuredCount, 0),
      aggregateTreasuryBalance: peers.reduce((sum, peer) => sum + peer.treasuryBalance, 0),
    },
  };
}

export async function getLiveNode0State() {
  const nodes = await crawlReferenceNetwork();
  const onlineNodes = nodes.filter((node) => node.summary.status === 'online' && node.peerState);
  const liveState = structuredClone(getNode0State());
  const configuredPeers = await getNode0PeerUrls();
  const registeredPeers = await readRegisteredPeers().catch(() => []);
  const canonicalPeer = onlineNodes
    .map((node) => ({
      summary: node.summary,
      peerState: node.peerState,
      epoch: Number(node.peerState?.chainConsensus?.currentEpoch || 0),
      chainHeight: Array.isArray(node.peerState?.chain) ? node.peerState.chain.length : 0,
    }))
    .sort((left, right) => {
      if (right.epoch !== left.epoch) {
        return right.epoch - left.epoch;
      }
      return right.chainHeight - left.chainHeight;
    })[0] || null;

  liveState.references = {
    peers: nodes.map((node) => node.summary),
    totals: {
      configuredPeers: configuredPeers.length,
      discoveredPeers: Math.max(0, nodes.length - configuredPeers.length),
      onlinePeers: onlineNodes.length,
      aggregateChainHeight: onlineNodes.reduce((sum, node) => sum + node.summary.chainHeight, 0),
      aggregateListings: onlineNodes.reduce((sum, node) => sum + node.summary.listingCount, 0),
      aggregateFeatured: onlineNodes.reduce((sum, node) => sum + node.summary.featuredCount, 0),
      aggregateTreasuryBalance: onlineNodes.reduce((sum, node) => sum + node.summary.treasuryBalance, 0),
    },
  };
  liveState.registrations = registeredPeers;

  liveState.featuredVideos = mergeUniqueBy(
    liveState.featuredVideos.map((item) => ({ id: item.proof, ...item })),
    onlineNodes.flatMap((node) => (node.peerState.featuredVideos || []).map((item) => ({ id: item.proof, ...item }))),
    'id'
  ).map(({ id, ...item }) => item);

  liveState.listings = mergeUniqueBy(liveState.listings || [], onlineNodes.flatMap((node) => node.peerState.listings || []), 'id');

  const longestPeerChain = onlineNodes
    .map((node) => node.peerState.chain || [])
    .sort((left, right) => right.length - left.length)[0];

  if (longestPeerChain && longestPeerChain.length > (liveState.chain || []).length) {
    liveState.chain = longestPeerChain;
  }

  if (canonicalPeer?.peerState?.chainConsensus) {
    liveState.chainConsensus = canonicalPeer.peerState.chainConsensus;
  }

  return liveState;
}

export async function getBootstrapResponse() {
  const liveState = await getLiveNode0State();
  const registrationPeers = (liveState.registrations || [])
    .filter((peer) => peer.status !== 'rejected')
    .map((peer) => normalizePeerUrl(peer.url))
    .filter(Boolean);
  const observedPeers = (liveState.references?.peers || [])
    .map((peer) => normalizePeerUrl(peer.url))
    .filter(Boolean);
  const seedPeers = await getNode0PeerUrls();
  const protocolBootstrap = {
    source: liveState.chainConsensus ? 'canonical-peer-export' : 'static-seed-fallback',
    protocol: liveState.chainConsensus?.protocol || null,
    currentEpoch: Number(liveState.chainConsensus?.currentEpoch || 0) || null,
    currentRound: Number(liveState.chainConsensus?.currentRound || 0) || null,
    validatorSetHash: liveState.chainConsensus?.validatorSetHash || null,
    validatorRegistry: liveState.chainConsensus?.validatorRegistry || [],
    epochChanges: liveState.chainConsensus?.epochChanges || [],
    peerAnnouncements: liveState.chainConsensus?.peerAnnouncements || [],
    lastFinalizedBlockHash: liveState.chainConsensus?.lastFinalizedBlockHash || liveState.chain.at(-1)?.hash || null,
  };

  return {
    network: liveState.network,
    manifest: liveState.manifest,
    economics: liveState.economics,
    contact: liveState.contact || null,
    references: liveState.references,
    chainHeight: liveState.chain.length,
    featuredCount: liveState.featuredVideos.length,
    listingCount: (liveState.listings || []).length,
    roadmapCount: (liveState.roadmap || []).length,
    registrationCount: (liveState.registrations || []).length,
    bootstrapHash: liveState.chain.at(-1)?.hash ?? null,
    discovery: {
      mode: 'federated-discovery',
      authority: 'advisory-only',
      node0Role: 'seed-discovery-and-observability',
      seedPeers,
      registrationPeers,
      observedPeers,
      peers: Array.from(new Set([...seedPeers, ...registrationPeers, ...observedPeers])),
    },
    protocolBootstrap,
  };
}
