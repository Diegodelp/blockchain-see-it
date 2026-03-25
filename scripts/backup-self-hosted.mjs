import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import path from 'node:path';

import { getBackupDir, getKeyStoreDir, getStorageDir } from '../lib/runtime-config.js';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function maybeHashFile(filepath) {
  try {
    const content = await fs.readFile(filepath);
    return { path: filepath, sha256: sha256(content), size: content.length };
  } catch {
    return null;
  }
}

async function collectFilesRecursively(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFilesRecursively(rootDir, absolutePath));
      continue;
    }

    if (entry.isFile()) {
      files.push({
        absolutePath,
        relativePath: path.relative(rootDir, absolutePath),
      });
    }
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function writeManifestWithDigest(targetDir, manifest) {
  const manifestPath = path.join(targetDir, 'manifest.json');
  const manifestBody = JSON.stringify(manifest, null, 2);
  await fs.writeFile(manifestPath, manifestBody, 'utf8');
  await fs.writeFile(path.join(targetDir, 'manifest.sha256'), `${sha256(Buffer.from(manifestBody, 'utf8'))}\n`, 'utf8');
}

async function main() {
  const storageDir = getStorageDir();
  const keyStoreDir = getKeyStoreDir();
  const backupRoot = getBackupDir();
  const backupId = new Date().toISOString().replace(/[:.]/g, '-');
  const targetDir = path.join(backupRoot, backupId);
  await fs.mkdir(targetDir, { recursive: true });

  const files = [
    { source: path.join(storageDir, 'state.sqlite'), destination: 'state.sqlite', kind: 'storage' },
    { source: path.join(storageDir, 'state.json'), destination: 'state.json', kind: 'storage' },
    { source: path.join(keyStoreDir, 'keystore.json'), destination: 'keystore.json', kind: 'keystore' },
  ];

  const manifest = {
    manifestVersion: 2,
    backupId,
    createdAt: new Date().toISOString(),
    storageDir,
    keyStoreDir,
    files: [],
    mediaFiles: [],
    totals: {
      files: 0,
      mediaFiles: 0,
      bytes: 0,
    },
  };

  for (const entry of files) {
    const sourceDigest = await maybeHashFile(entry.source);
    if (!sourceDigest) {
      continue;
    }

    const destinationPath = path.join(targetDir, entry.destination);
    await fs.copyFile(entry.source, destinationPath);
    const destinationDigest = await maybeHashFile(destinationPath);
    if (!destinationDigest || destinationDigest.sha256 !== sourceDigest.sha256) {
      throw new Error(`Backup copy verification failed for ${entry.source}`);
    }

    manifest.files.push({
      kind: entry.kind,
      source: entry.source,
      destination: entry.destination,
      sha256: destinationDigest.sha256,
      size: destinationDigest.size,
    });
    manifest.totals.files += 1;
    manifest.totals.bytes += destinationDigest.size;
  }

  const mediaSource = path.join(storageDir, 'media');
  const mediaDestination = path.join(targetDir, 'media');
  const mediaEntries = await collectFilesRecursively(mediaSource).catch(() => []);
  if (mediaEntries.length > 0) {
    await fs.mkdir(mediaDestination, { recursive: true });
  }
  for (const entry of mediaEntries) {
    const targetFile = path.join(mediaDestination, entry.relativePath);
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.copyFile(entry.absolutePath, targetFile);
    const sourceDigest = await maybeHashFile(entry.absolutePath);
    const destinationDigest = await maybeHashFile(targetFile);
    if (!sourceDigest || !destinationDigest || sourceDigest.sha256 !== destinationDigest.sha256) {
      throw new Error(`Backup copy verification failed for media file ${entry.relativePath}`);
    }

    manifest.mediaFiles.push({
      file: entry.relativePath,
      sha256: destinationDigest.sha256,
      size: destinationDigest.size,
    });
    manifest.totals.mediaFiles += 1;
    manifest.totals.bytes += destinationDigest.size;
  }

  await writeManifestWithDigest(targetDir, manifest);
  console.log(JSON.stringify({
    ok: true,
    backupDir: targetDir,
    files: manifest.totals.files,
    mediaFiles: manifest.totals.mediaFiles,
    bytes: manifest.totals.bytes,
  }));
}

await main();
