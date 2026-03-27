import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREBUILT_BUNDLE_PATH = path.join(PROJECT_ROOT, 'artifacts', 'streamchain-self-hosted-kit.tar.gz');

const EXCLUDED_PREFIXES = [
  '.git',
  'node_modules',
  '.next',
  'storage',
  'videos',
  'blockchain/blockchain/__pycache__',
];

function shouldExclude(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) {
    return false;
  }
  if (normalized.endsWith('.pyc')) {
    return true;
  }
  return EXCLUDED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

async function collectFiles(rootDir, currentDir = rootDir, collected = []) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, '/');

    if (shouldExclude(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await collectFiles(rootDir, absolutePath, collected);
      continue;
    }

    if (entry.isFile()) {
      collected.push({ absolutePath, relativePath });
    }
  }

  return collected.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function directoryExists(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function resolveBundleRoot(rootDir) {
  if (rootDir) {
    if (await directoryExists(rootDir)) {
      return rootDir;
    }
    throw new Error(`Bundle root no existe o no es un directorio: ${rootDir}`);
  }

  const envRoot = String(process.env.STREAMCHAIN_BUNDLE_ROOT || '').trim();
  const candidates = [
    envRoot,
    PROJECT_ROOT,
    process.cwd(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await directoryExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`No se encontró un directorio válido para generar el bundle (candidatos: ${candidates.join(', ')})`);
}

function writeString(buffer, value, offset, length) {
  buffer.write(String(value).slice(0, length), offset, Math.min(length, Buffer.byteLength(String(value))), 'utf8');
}

function writeOctal(buffer, value, offset, length) {
  const octal = value.toString(8).padStart(length - 1, '0');
  writeString(buffer, `${octal}\0`, offset, length);
}

function splitTarPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const bytes = Buffer.byteLength(normalized);
  if (bytes <= 100) {
    return { name: normalized, prefix: '' };
  }

  const parts = normalized.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }

  throw new Error(`Path demasiado largo para TAR: ${relativePath}`);
}

function createTarHeader(relativePath, stats) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(relativePath);

  writeString(header, name, 0, 100);
  writeOctal(header, stats.mode & 0o777, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, stats.size, 124, 12);
  writeOctal(header, Math.floor(stats.mtimeMs / 1000), 136, 12);
  writeString(header, '        ', 148, 8);
  writeString(header, '0', 156, 1);
  writeString(header, 'ustar', 257, 6);
  writeString(header, '00', 263, 2);
  writeString(header, prefix, 345, 155);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeString(header, `${checksumText}\0 `, 148, 8);

  return header;
}

function padTo512(buffer) {
  const remainder = buffer.length % 512;
  if (remainder === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.alloc(512 - remainder, 0);
}

function createTarArchive(files) {
  const chunks = [];

  for (const file of files) {
    chunks.push(file.header);
    chunks.push(file.content);
    chunks.push(padTo512(file.content));
  }

  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export async function createSelfHostedBundle(rootDir) {
  const resolvedRoot = await resolveBundleRoot(rootDir);
  const fileEntries = await collectFiles(resolvedRoot);
  const files = [];

  for (const entry of fileEntries) {
    const [content, stats] = await Promise.all([
      fs.readFile(entry.absolutePath),
      fs.stat(entry.absolutePath),
    ]);

    files.push({
      header: createTarHeader(entry.relativePath, stats),
      content,
    });
  }

  return gzipSync(createTarArchive(files));
}

export async function getSelfHostedBundle(rootDir) {
  try {
    return await fs.readFile(PREBUILT_BUNDLE_PATH);
  } catch {
    return createSelfHostedBundle(rootDir);
  }
}
