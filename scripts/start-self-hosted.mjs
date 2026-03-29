import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT_DIR = process.cwd();
const DEFAULT_NODE0_URL = 'https://blockchain-gilt-rho.vercel.app';
const NGROK_DOWNLOADS = {
  'linux:x64': 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz',
  'linux:arm64': 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz',
  'darwin:x64': 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-amd64.tgz',
  'darwin:arm64': 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-arm64.tgz',
  'win32:x64': 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip',
};

let ngrokProcess = null;

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function log(message, payload) {
  if (typeof payload === 'undefined') {
    console.log(`[streamchain:start] ${message}`);
    return;
  }

  console.log(`[streamchain:start] ${message}`, payload);
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export function parseEnvAssignments(content, targetEnv = process.env) {
  const applied = {};

  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (typeof targetEnv[key] !== 'undefined') {
      continue;
    }

    let value = rawValue.trim();
    const commentIndex = value.search(/\s+#/);
    if (commentIndex >= 0 && !(value.startsWith('"') || value.startsWith("'"))) {
      value = value.slice(0, commentIndex).trim();
    }

    const normalized = stripWrappingQuotes(value);
    targetEnv[key] = normalized;
    applied[key] = normalized;
  }

  return applied;
}

export async function loadEnvFile(filename, targetEnv = process.env) {
  const filepath = path.join(ROOT_DIR, filename);
  if (!(await pathExists(filepath))) {
    return {};
  }

  const content = await fs.readFile(filepath, 'utf8');
  return parseEnvAssignments(content, targetEnv);
}

async function loadRuntimeEnv() {
  const nodeEnv = process.env.NODE_ENV || 'production';
  await loadEnvFile('.env');
  await loadEnvFile(`.env.${nodeEnv}`);
  await loadEnvFile('.env.local');
  await loadEnvFile(`.env.${nodeEnv}.local`);
}

function isSelfHosted() {
  return process.env.STREAMCHAIN_NODE_MODE === 'self-hosted';
}

function shouldAutoBootstrap() {
  return String(process.env.STREAMCHAIN_AUTO_BOOTSTRAP || 'true').toLowerCase() !== 'false';
}

function shouldAutoNgrok() {
  return String(process.env.STREAMCHAIN_AUTO_NGROK || 'false').toLowerCase() === 'true';
}

function shouldAutoRegisterWithNode0() {
  return String(process.env.STREAMCHAIN_AUTO_NODE0_REGISTER || 'true').toLowerCase() !== 'false';
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check, { attempts = 60, delayMs = 1000, label = 'condition' } = {}) {
  let lastError = null;

  for (let index = 0; index < attempts; index += 1) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(delayMs);
  }

  throw lastError || new Error(`Timed out while waiting for ${label}.`);
}

async function runCommand(command, args, { allowFailure = false } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || allowFailure) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findExecutableOnPath(command) {
  const pathValue = String(process.env.PATH || '');
  if (!pathValue) {
    return '';
  }

  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? Array.from(new Set(['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)]))
    : [''];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, process.platform === 'win32' ? `${command}${extension}` : command);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  return '';
}

async function findPortableNgrokBinary() {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const configuredDirs = String(process.env.STREAMCHAIN_NGROK_SEARCH_DIRS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const candidateRoots = Array.from(new Set([
    ...configuredDirs,
    homeDir ? path.join(homeDir, 'Desktop') : '',
    homeDir ? path.join(homeDir, 'Downloads') : '',
    homeDir ? path.join(homeDir, 'Documents') : '',
    homeDir ? path.join(homeDir, 'OneDrive', 'Desktop') : '',
  ].filter(Boolean)));

  const binaryNames = Array.from(new Set(
    process.platform === 'win32'
      ? ['ngrok.exe', 'ngrok.cmd', 'ngrok.bat', 'ngrok']
      : ['ngrok', 'ngrok.exe']
  ));

  for (const root of candidateRoots) {
    if (!(await pathExists(root))) {
      continue;
    }

    for (const binaryName of binaryNames) {
      const directCandidate = path.join(root, binaryName);
      if (await pathExists(directCandidate)) {
        return directCandidate;
      }
    }

    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      for (const binaryName of binaryNames) {
        const nestedCandidate = path.join(root, entry.name, binaryName);
        if (await pathExists(nestedCandidate)) {
          return nestedCandidate;
        }
      }
    }
  }

  return '';
}

async function extractArchive(archivePath, destinationDir) {
  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await runCommand('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
      ]);
      return;
    }

    await runCommand('unzip', ['-o', archivePath, '-d', destinationDir]);
    return;
  }

  await runCommand('tar', ['-xzf', archivePath, '-C', destinationDir]);
}

async function ensureNgrokBinary() {
  if (process.env.STREAMCHAIN_NGROK_BINARY) {
    return process.env.STREAMCHAIN_NGROK_BINARY;
  }

  const binaryName = process.platform === 'win32' ? 'ngrok.exe' : 'ngrok';
  const installDir = path.join(ROOT_DIR, '.cache', 'streamchain-ngrok');
  const binaryPath = path.join(installDir, binaryName);

  const installedNgrok = await findExecutableOnPath('ngrok');
  if (installedNgrok) {
    return installedNgrok;
  }

  const portableNgrok = await findPortableNgrokBinary();
  if (portableNgrok) {
    return portableNgrok;
  }

  if (await pathExists(binaryPath)) {
    return binaryPath;
  }

  const allowDownload = String(process.env.STREAMCHAIN_NGROK_ALLOW_DOWNLOAD || 'false').toLowerCase() === 'true';
  if (!allowDownload) {
    throw new Error('ngrok is not installed locally and automatic download is disabled. Set STREAMCHAIN_NGROK_ALLOW_DOWNLOAD=true to opt in.');
  }

  const authToken = String(process.env.STREAMCHAIN_NGROK_AUTHTOKEN || '').trim();
  if (!authToken) {
    throw new Error('ngrok is not installed and STREAMCHAIN_NGROK_AUTHTOKEN is not set for automatic download.');
  }

  const key = `${process.platform}:${process.arch}`;
  const downloadUrl = NGROK_DOWNLOADS[key];
  if (!downloadUrl) {
    throw new Error(`No ngrok download is configured for ${key}.`);
  }

  await fs.mkdir(installDir, { recursive: true });
  const archivePath = path.join(installDir, path.basename(downloadUrl));

  log('Downloading ngrok automatically', { downloadUrl });
  await runCommand('curl', ['-fsSL', downloadUrl, '-o', archivePath]);
  await extractArchive(archivePath, installDir);

  await fs.chmod(binaryPath, 0o755);
  return binaryPath;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }

  return payload;
}

export function collectDiscoveredPeerUrls({ bootstrap, manifest, registry, node0Url, publicUrl }) {
  return Array.from(
    new Set(
      [
        ...(bootstrap?.discovery?.seedPeers || []).map((url) => normalizeUrl(url)),
        ...(bootstrap?.discovery?.registrationPeers || []).map((url) => normalizeUrl(url)),
        ...(bootstrap?.discovery?.observedPeers || []).map((url) => normalizeUrl(url)),
        ...(bootstrap?.protocolBootstrap?.peerAnnouncements || []).map((entry) => normalizeUrl(entry?.url)),
        ...(bootstrap?.references?.peers || []).map((peer) => normalizeUrl(peer?.url)),
        ...(manifest?.references?.peers || []).map((peer) => normalizeUrl(peer?.url)),
        ...(registry?.peers || []).map((peer) => normalizeUrl(peer?.url)),
      ].filter((url) => url && url !== node0Url && url !== publicUrl)
    )
  ).sort((left, right) => left.localeCompare(right));
}

async function getExistingNgrokTunnel(apiAddr) {
  const response = await fetch(`http://${apiAddr}/api/tunnels`).catch(() => null);
  if (!response?.ok) {
    return '';
  }

  const payload = await response.json();
  const tunnel = (payload.tunnels || []).find((item) => String(item.public_url || '').startsWith('https://'));
  return normalizeUrl(tunnel?.public_url);
}

async function startNgrokTunnel() {
  if (!isSelfHosted()) {
    return normalizeUrl(process.env.STREAMCHAIN_PUBLIC_URL);
  }

  const configuredPublicUrl = normalizeUrl(process.env.STREAMCHAIN_PUBLIC_URL);
  if (configuredPublicUrl) {
    return configuredPublicUrl;
  }

  if (!shouldAutoNgrok()) {
    log('Automatic ngrok disabled by STREAMCHAIN_AUTO_NGROK=false.');
    return '';
  }

  const apiAddr = process.env.STREAMCHAIN_NGROK_API_ADDR || '127.0.0.1:4040';
  const existingTunnelUrl = await getExistingNgrokTunnel(apiAddr);
  if (existingTunnelUrl) {
    process.env.STREAMCHAIN_PUBLIC_URL = existingTunnelUrl;
    log('Reusing existing ngrok tunnel', { publicUrl: existingTunnelUrl });
    return existingTunnelUrl;
  }

  const binaryPath = await ensureNgrokBinary();
  const authToken = String(process.env.STREAMCHAIN_NGROK_AUTHTOKEN || '').trim();
  const port = String(process.env.PORT || '3000');
  const installDir = path.dirname(binaryPath);
  const configPath = path.join(installDir, 'ngrok.yml');
  if (authToken) {
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(configPath, `version: 2\nauthtoken: ${authToken}\n`, 'utf8');
  }

  const ngrokArgs = ['http', port, '--log', 'stdout'];
  if (authToken) {
    ngrokArgs.push('--config', configPath);
  }

  ngrokProcess = spawn(binaryPath, ngrokArgs, {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  ngrokProcess.stdout.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      console.log(`[streamchain:ngrok] ${text}`);
    }
  });
  ngrokProcess.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      console.error(`[streamchain:ngrok] ${text}`);
    }
  });

  ngrokProcess.on('exit', (code, signal) => {
    if (code !== null || signal) {
      log('ngrok process exited', { code, signal });
    }
  });

  const tunnelUrl = await waitFor(async () => {
    const response = await fetch(`http://${apiAddr}/api/tunnels`);
    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const tunnel = (payload.tunnels || []).find((item) => String(item.public_url || '').startsWith('https://'));
    return normalizeUrl(tunnel?.public_url);
  }, {
    attempts: 45,
    delayMs: 1000,
    label: 'ngrok tunnel',
  });

  process.env.STREAMCHAIN_PUBLIC_URL = tunnelUrl;
  log('Automatic ngrok tunnel ready', { publicUrl: tunnelUrl });
  return tunnelUrl;
}

function createShutdownHandler(nextProcess) {
  return async () => {
    if (ngrokProcess && !ngrokProcess.killed) {
      ngrokProcess.kill('SIGTERM');
    }

    if (nextProcess && !nextProcess.killed) {
      nextProcess.kill('SIGTERM');
    }
  };
}

async function waitForServer(localBaseUrl) {
  await waitFor(async () => {
    const response = await fetch(`${localBaseUrl}/api/integrity`);
    return response.ok;
  }, {
    attempts: 60,
    delayMs: 1000,
    label: 'local Next.js server',
  });
}

async function bootstrapSelfHostedNetwork(localBaseUrl, publicUrl) {
  if (!isSelfHosted() || !shouldAutoBootstrap()) {
    return;
  }

  const node0Url = normalizeUrl(process.env.STREAMCHAIN_GENESIS_NODE0_URL || DEFAULT_NODE0_URL);
  const registrationSecret = String(process.env.STREAMCHAIN_NODE0_REGISTRATION_SECRET || '').trim();
  const operatorToken = String(process.env.STREAMCHAIN_OPERATOR_TOKEN || '').trim();
  const operatorHeaders = operatorToken ? { 'x-streamchain-operator-token': operatorToken } : {};

  if (!node0Url) {
    log('Skipping bootstrap because no genesis node0 URL is configured.');
    return;
  }

  try {
    await fetchJson(`${localBaseUrl}/api/node/peers`, {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ url: node0Url }),
    });
    log('Linked node0 as read-only automatically', { node0Url });
  } catch (error) {
    log('Automatic read-only node0 link failed', { node0Url, message: error.message });
  }

  if (publicUrl && shouldAutoRegisterWithNode0()) {
    try {
      await fetchJson(`${localBaseUrl}/api/node/link-node0`, {
        method: 'POST',
        headers: operatorHeaders,
        body: JSON.stringify({
          node0Url,
          publicUrl,
          registrationSecret,
        }),
      });
      log('Announced this node to node0 automatically', { node0Url, publicUrl });
    } catch (error) {
      log('Automatic node0 announcement failed', { node0Url, publicUrl, message: error.message });
    }
  } else if (publicUrl) {
    log('Skipping automatic node0 public registration; enable STREAMCHAIN_AUTO_NODE0_REGISTER=true to opt in.', { node0Url, publicUrl });
  }

  const manifest = await fetchJson(`${node0Url}/api/manifest`, {
    method: 'GET',
    headers: {},
  }).catch((error) => {
    log('Could not read node0 manifest for auto-discovery', { message: error.message });
    return null;
  });

  const bootstrap = await fetchJson(`${node0Url}/api/bootstrap`, {
    method: 'GET',
    headers: {},
  }).catch((error) => {
    log('Could not read node0 bootstrap for auto-discovery', { message: error.message });
    return null;
  });

  const discoveredPeerUrls = collectDiscoveredPeerUrls({
    bootstrap,
    manifest,
    node0Url,
    publicUrl,
  });

  for (const peerUrl of discoveredPeerUrls) {
    try {
      await fetchJson(`${localBaseUrl}/api/node/peers`, {
        method: 'POST',
        headers: operatorHeaders,
        body: JSON.stringify({ url: peerUrl }),
      });
      log('Auto-linked discovered peer', { peerUrl });
    } catch (error) {
      log('Auto-link for discovered peer failed', { peerUrl, message: error.message });
    }
  }
}

async function main() {
  await loadRuntimeEnv();

  const publicUrl = await startNgrokTunnel().catch((error) => {
    log('Automatic ngrok setup failed; continuing without a tunnel.', { message: error.message });
    return normalizeUrl(process.env.STREAMCHAIN_PUBLIC_URL);
  });

  const nextBin = path.join(ROOT_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
  const nextProcess = spawn(process.execPath, [nextBin, 'start'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      STREAMCHAIN_PUBLIC_URL: publicUrl || process.env.STREAMCHAIN_PUBLIC_URL || '',
    },
  });

  const shutdown = createShutdownHandler(nextProcess);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const localBaseUrl = `http://127.0.0.1:${process.env.PORT || '3000'}`;
  waitForServer(localBaseUrl)
    .then(() => bootstrapSelfHostedNetwork(localBaseUrl, publicUrl))
    .catch((error) => {
      log('Automatic bootstrap skipped because the local server was not ready.', { message: error.message });
    });

  nextProcess.on('exit', async (code, signal) => {
    await shutdown();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  await main();
}
