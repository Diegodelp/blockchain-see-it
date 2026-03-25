import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import path from 'node:path';

import { getBackupDir, getKeyStoreDir, getStorageDir } from '../lib/runtime-config.js';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function verifyFile(filepath, expectedHash) {
  const content = await fs.readFile(filepath);
  const actualHash = sha256(content);
  if (actualHash !== expectedHash) {
    throw new Error(`Hash mismatch for ${filepath}`);
  }
}

async function verifyManifestDigest(sourceDir) {
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const digestPath = path.join(sourceDir, 'manifest.sha256');
  const [manifestBody, expectedDigest] = await Promise.all([
    fs.readFile(manifestPath),
    fs.readFile(digestPath, 'utf8'),
  ]);
  const actualDigest = sha256(manifestBody);
  if (actualDigest !== expectedDigest.trim()) {
    throw new Error('Backup manifest digest mismatch.');
  }
  return JSON.parse(manifestBody.toString('utf8'));
}

async function main() {
  const backupRoot = getBackupDir();
  const backupId = process.argv[2];
  if (!backupId) {
    throw new Error('Usage: node scripts/restore-self-hosted.mjs <backup-id>');
  }

  const sourceDir = path.join(backupRoot, backupId);
  const manifest = await verifyManifestDigest(sourceDir);
  const storageDir = getStorageDir();
  const keyStoreDir = getKeyStoreDir();
  await fs.mkdir(storageDir, { recursive: true });
  await fs.mkdir(keyStoreDir, { recursive: true });

  for (const entry of manifest.files || []) {
    const source = path.join(sourceDir, entry.destination);
    await verifyFile(source, entry.sha256);
  }
  for (const entry of manifest.mediaFiles || []) {
    await verifyFile(path.join(sourceDir, 'media', entry.file), entry.sha256);
  }

  for (const entry of manifest.files || []) {
    const source = path.join(sourceDir, entry.destination);
    const target = entry.kind === 'keystore'
      ? path.join(keyStoreDir, entry.destination)
      : path.join(storageDir, entry.destination);
    await fs.copyFile(source, target);
  }

  const mediaTarget = path.join(storageDir, 'media');
  if ((manifest.mediaFiles || []).length > 0) {
    await fs.rm(mediaTarget, { recursive: true, force: true });
    for (const entry of manifest.mediaFiles || []) {
      const source = path.join(sourceDir, 'media', entry.file);
      const target = path.join(mediaTarget, entry.file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    restoredFrom: sourceDir,
    manifestVersion: manifest.manifestVersion || 1,
    files: (manifest.files || []).length,
    mediaFiles: (manifest.mediaFiles || []).length,
  }));
}

await main();
