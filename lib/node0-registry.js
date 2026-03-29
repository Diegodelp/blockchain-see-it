import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const REGISTRY_FILE = 'node0-peer-registry.json';

function getRegistryCache() {
  if (!globalThis.__streamchainNode0Registry) {
    globalThis.__streamchainNode0Registry = [];
  }

  return globalThis.__streamchainNode0Registry;
}

function mergeRegistryEntries(current, incoming) {
  const next = [...current];

  for (const entry of incoming || []) {
    const index = next.findIndex((item) => item.url === entry.url);
    if (index >= 0) {
      next[index] = {
        ...next[index],
        ...entry,
      };
    } else {
      next.push(entry);
    }
  }

  return next.sort((left, right) => left.url.localeCompare(right.url));
}

function getRegistryDir() {
  if (process.env.STREAMCHAIN_NODE0_REGISTRY_DIR) {
    return path.resolve(process.env.STREAMCHAIN_NODE0_REGISTRY_DIR);
  }

  if (process.env.VERCEL) {
    return '/tmp/streamchain-node0';
  }

  return path.join(process.cwd(), 'storage');
}

function getFallbackRegistryDir() {
  return path.join(os.tmpdir(), 'streamchain-node0');
}

async function ensureRegistryFile() {
  const configuredDir = getRegistryDir();
  let dir = configuredDir;
  let filepath = path.join(dir, REGISTRY_FILE);

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    const fallbackDir = getFallbackRegistryDir();
    if (path.resolve(fallbackDir) === path.resolve(dir)) {
      throw error;
    }

    console.warn('[streamchain:node0-registry] failed to initialize registry directory, using tmp fallback', {
      configuredDir,
      fallbackDir,
      code: error?.code || null,
      message: error?.message || null,
    });
    dir = fallbackDir;
    filepath = path.join(dir, REGISTRY_FILE);
    await fs.mkdir(dir, { recursive: true });
  }

  try {
    await fs.access(filepath);
  } catch {
    await fs.writeFile(filepath, '[]');
  }

  return filepath;
}

export async function readRegisteredPeers() {
  const filepath = await ensureRegistryFile();
  const content = await fs.readFile(filepath, 'utf8');
  const parsed = JSON.parse(content);
  const merged = mergeRegistryEntries(getRegistryCache(), Array.isArray(parsed) ? parsed : []);
  globalThis.__streamchainNode0Registry = merged;
  return merged;
}

export async function upsertRegisteredPeer(entry) {
  const filepath = await ensureRegistryFile();
  const entries = await readRegisteredPeers();
  const next = mergeRegistryEntries(entries, [entry]);
  globalThis.__streamchainNode0Registry = next;
  await fs.writeFile(filepath, JSON.stringify(next, null, 2));
  return next;
}
