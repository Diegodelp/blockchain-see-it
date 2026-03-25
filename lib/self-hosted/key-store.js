import fs from 'fs/promises';
import path from 'path';

const KEYSTORE_FILE = 'keystore.json';

function defaultKeyEntry(keypair, timestamp = new Date().toISOString()) {
  return {
    id: `node-signer-${timestamp}`,
    purpose: 'node-signer',
    algorithm: 'secp256k1',
    status: 'active',
    createdAt: timestamp,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
  };
}

function sanitizeKeyEntry(entry = {}) {
  return {
    id: entry.id || `node-signer-${Date.now()}`,
    purpose: entry.purpose || 'node-signer',
    algorithm: entry.algorithm || 'secp256k1',
    status: entry.status || 'active',
    createdAt: entry.createdAt || new Date().toISOString(),
    retiredAt: entry.retiredAt || null,
    publicKey: entry.publicKey || null,
    privateKey: entry.privateKey || null,
  };
}

export function getKeyStorePath(storageDir) {
  return path.join(storageDir, KEYSTORE_FILE);
}

async function readConfiguredPrivateKey(configured = {}) {
  if (configured.privateKey) {
    return configured.privateKey;
  }
  if (configured.privateKeyFile) {
    return fs.readFile(configured.privateKeyFile, 'utf8').then((value) => value.trim());
  }
  return null;
}

export async function readKeyStore(storageDir) {
  try {
    const content = await fs.readFile(getKeyStorePath(storageDir), 'utf8');
    const parsed = JSON.parse(content);
    return {
      version: Number(parsed.version || 1),
      currentKeyId: parsed.currentKeyId || null,
      keys: Array.isArray(parsed.keys) ? parsed.keys.map(sanitizeKeyEntry) : [],
      rotation: parsed.rotation || { pendingKeyId: null, lastRotatedAt: null },
    };
  } catch {
    return null;
  }
}

export async function writeKeyStore(storageDir, keyStore) {
  await fs.writeFile(
    getKeyStorePath(storageDir),
    JSON.stringify({
      version: Number(keyStore.version || 1),
      currentKeyId: keyStore.currentKeyId || null,
      keys: Array.isArray(keyStore.keys) ? keyStore.keys.map(sanitizeKeyEntry) : [],
      rotation: keyStore.rotation || { pendingKeyId: null, lastRotatedAt: null },
    }, null, 2),
    'utf8'
  );
}

export function getCurrentNodeSignerFromKeyStore(keyStore) {
  if (!keyStore?.currentKeyId) {
    return null;
  }

  const entry = (keyStore.keys || []).find((candidate) => candidate.id === keyStore.currentKeyId && candidate.status === 'active');
  if (!entry?.publicKey || !entry?.privateKey) {
    return null;
  }

  return {
    keyId: entry.id,
    publicKey: entry.publicKey,
    privateKey: entry.privateKey,
  };
}

export async function ensureNodeSignerKeyStore({
  storageDir,
  keyStoreDir = storageDir,
  state,
  createWalletKeypair,
  configuredNodeSigner = null,
  derivePublicKey = null,
}) {
  let keyStore = await readKeyStore(keyStoreDir);

  const configuredPrivateKey = await readConfiguredPrivateKey(configuredNodeSigner || {});
  const configuredPublicKey = configuredNodeSigner?.publicKey || (configuredPrivateKey && derivePublicKey
    ? derivePublicKey(configuredPrivateKey)
    : null);

  if (!keyStore) {
    const migratedKeypair = configuredPrivateKey && configuredPublicKey
      ? {
        privateKey: configuredPrivateKey,
        publicKey: configuredPublicKey,
      }
      : (state?.network?.nodeSignerPrivateKey && state?.network?.nodeSignerPublicKey
      ? {
        privateKey: state.network.nodeSignerPrivateKey,
        publicKey: state.network.nodeSignerPublicKey,
      }
      : createWalletKeypair());
    const entry = defaultKeyEntry(migratedKeypair);
    keyStore = {
      version: 1,
      currentKeyId: entry.id,
      keys: [entry],
      rotation: {
        pendingKeyId: null,
        lastRotatedAt: null,
      },
    };
    await writeKeyStore(keyStoreDir, keyStore);
  }

  const signer = getCurrentNodeSignerFromKeyStore(keyStore);
  if (!signer) {
    const replacement = defaultKeyEntry(createWalletKeypair());
    keyStore = {
      ...keyStore,
      currentKeyId: replacement.id,
      keys: [...(keyStore.keys || []).filter((entry) => entry.id !== replacement.id), replacement],
      rotation: {
        ...(keyStore.rotation || {}),
        lastRotatedAt: new Date().toISOString(),
      },
    };
    await writeKeyStore(keyStoreDir, keyStore);
    return getCurrentNodeSignerFromKeyStore(keyStore);
  }

  if (configuredPrivateKey && configuredPublicKey && (signer.privateKey !== configuredPrivateKey || signer.publicKey !== configuredPublicKey)) {
    const replacement = defaultKeyEntry({ privateKey: configuredPrivateKey, publicKey: configuredPublicKey });
    keyStore = {
      ...keyStore,
      currentKeyId: replacement.id,
      keys: [...(keyStore.keys || []).map((entry) => ({ ...entry, status: entry.id === keyStore.currentKeyId ? 'retired' : entry.status })), replacement],
      rotation: {
        ...(keyStore.rotation || {}),
        lastRotatedAt: new Date().toISOString(),
      },
    };
    await writeKeyStore(keyStoreDir, keyStore);
    return getCurrentNodeSignerFromKeyStore(keyStore);
  }

  return signer;
}

export function attachNodeSignerToState(state, signer) {
  if (!state?.network || !signer) {
    return state;
  }

  state.network = {
    ...state.network,
    nodeSignerKeyId: signer.keyId || null,
    nodeSignerPublicKey: signer.publicKey,
    nodeSignerPrivateKey: signer.privateKey,
    keyManagement: {
      type: 'local-keystore',
      activeKeyId: signer.keyId || null,
      rotationPending: false,
    },
  };
  return state;
}

export function stripNodeSignerPrivateMaterial(state) {
  if (!state?.network) {
    return state;
  }

  const nextState = structuredClone(state);
  if (nextState.network) {
    delete nextState.network.nodeSignerPrivateKey;
    nextState.network.keyManagement = {
      type: 'local-keystore',
      activeKeyId: nextState.network.nodeSignerKeyId || null,
      rotationPending: false,
    };
  }
  return nextState;
}
