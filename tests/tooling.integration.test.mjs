import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { GET as healthGET } from '../app/api/health/route.js';
import { GET as metricsGET } from '../app/api/metrics/route.js';
import { POST as registerPOST } from '../app/api/node0/register/route.js';
import { POST as mediaPOST } from '../app/api/node/media/route.js';
import { createFederationRequestHeaders, verifyFederationRequest } from '../app/api/_lib/federation-auth.js';
import { assertOperatorAccess, getOperatorAccess } from '../app/api/_lib/security.js';
import { createWalletKeypair } from '../lib/transaction-security.js';
import { createSelfHostedBundle, getSelfHostedBundle } from '../lib/install-bundle.js';
import { consumeRateLimit } from '../lib/rate-limit-store.js';
import { collectDiscoveredPeerUrls, parseEnvAssignments } from '../scripts/start-self-hosted.mjs';

const execFileAsync = promisify(execFile);

function listTarEntries(buffer) {
  const entries = [];
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const dataBlocks = Math.ceil(size / 512);

    entries.push(fullName);
    offset += 512 + (dataBlocks * 512);
  }

  return entries;
}

test('createSelfHostedBundle excludes runtime-heavy paths and keeps app files', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-bundle-'));

  try {
    await mkdir(path.join(rootDir, 'app'), { recursive: true });
    await mkdir(path.join(rootDir, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(rootDir, '.next'), { recursive: true });
    await mkdir(path.join(rootDir, 'storage'), { recursive: true });
    await mkdir(path.join(rootDir, 'videos'), { recursive: true });
    await mkdir(path.join(rootDir, 'blockchain', 'blockchain', '__pycache__'), { recursive: true });

    await writeFile(path.join(rootDir, 'README.md'), '# demo bundle\n');
    await writeFile(path.join(rootDir, 'app', 'page.jsx'), 'export default function Page() { return null; }\n');
    await writeFile(path.join(rootDir, 'node_modules', 'pkg', 'index.js'), 'ignored\n');
    await writeFile(path.join(rootDir, '.next', 'trace'), 'ignored\n');
    await writeFile(path.join(rootDir, 'storage', 'state.json'), '{}\n');
    await writeFile(path.join(rootDir, 'storage', 'state.sqlite'), 'ignored\n');
    await writeFile(path.join(rootDir, 'videos', 'asset.mp4'), 'ignored\n');
    await writeFile(path.join(rootDir, 'blockchain', 'blockchain', '__pycache__', 'cached.pyc'), 'ignored\n');
    await writeFile(path.join(rootDir, 'ignored.pyc'), 'ignored\n');

    const archive = await createSelfHostedBundle(rootDir);
    const entries = listTarEntries(gunzipSync(archive));

    assert.ok(entries.includes('README.md'));
    assert.ok(entries.includes('app/page.jsx'));
    assert.ok(!entries.includes('node_modules/pkg/index.js'));
    assert.ok(!entries.includes('.next/trace'));
    assert.ok(!entries.includes('storage/state.json'));
    assert.ok(!entries.includes('storage/state.sqlite'));
    assert.ok(!entries.includes('videos/asset.mp4'));
    assert.ok(!entries.includes('blockchain/blockchain/__pycache__/cached.pyc'));
    assert.ok(!entries.includes('ignored.pyc'));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('createSelfHostedBundle default root does not depend on process cwd', async () => {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-cwd-'));

  try {
    process.chdir(tempDir);
    const archive = await createSelfHostedBundle();
    const entries = listTarEntries(gunzipSync(archive));

    assert.ok(entries.includes('app/page.jsx'));
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('createSelfHostedBundle fails fast with clear error when rootDir does not exist', async () => {
  await assert.rejects(
    () => createSelfHostedBundle('/path/that/does-not-exist'),
    /Bundle root no existe o no es un directorio/,
  );
});

test('getSelfHostedBundle prefers prebuilt artifact when available', async () => {
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  const prebuiltPath = path.join(artifactsDir, 'streamchain-self-hosted-kit.tar.gz');
  const prebuiltPayload = Buffer.from('prebuilt-bundle');

  let backup = null;

  try {
    try {
      backup = await readFile(prebuiltPath);
    } catch {
      backup = null;
    }

    await mkdir(artifactsDir, { recursive: true });
    await writeFile(prebuiltPath, prebuiltPayload);

    const bundle = await getSelfHostedBundle('/path/that/does-not-exist');
    assert.equal(bundle.equals(prebuiltPayload), true);
  } finally {
    if (backup) {
      await writeFile(prebuiltPath, backup);
    } else {
      await rm(prebuiltPath, { force: true });
    }
  }
});

test('parseEnvAssignments respects existing env vars and strips quotes/comments', () => {
  const targetEnv = { KEEP_ME: 'original' };
  const applied = parseEnvAssignments(`
# comment
KEEP_ME=override-me
PLAIN=value # inline comment
QUOTED="quoted value"
SINGLE='single value'
EMPTY=
INVALID LINE
`, targetEnv);

  assert.deepEqual(applied, {
    PLAIN: 'value',
    QUOTED: 'quoted value',
    SINGLE: 'single value',
    EMPTY: '',
  });
  assert.equal(targetEnv.KEEP_ME, 'original');
  assert.equal(targetEnv.PLAIN, 'value');
  assert.equal(targetEnv.QUOTED, 'quoted value');
  assert.equal(targetEnv.SINGLE, 'single value');
  assert.equal(targetEnv.EMPTY, '');
});

test('collectDiscoveredPeerUrls deduplicates peers and filters node0/public self URLs', () => {
  const peers = collectDiscoveredPeerUrls({
    bootstrap: {
      discovery: {
        seedPeers: [
          'https://peer-a.example.com/',
          'https://node0.example.com',
        ],
        registrationPeers: [
          'https://peer-c.example.com/',
        ],
        observedPeers: [
          'https://peer-d.example.com/',
          'https://self.example.com',
        ],
      },
      protocolBootstrap: {
        peerAnnouncements: [
          { url: 'https://peer-f.example.com/' },
        ],
      },
      references: {
        peers: [
          { url: 'https://peer-e.example.com/' },
        ],
      },
    },
    manifest: {
      references: {
        peers: [
          { url: 'https://peer-a.example.com/' },
          { url: 'https://peer-b.example.com' },
          { url: 'https://node0.example.com' },
        ],
      },
    },
    registry: {
      peers: [
        { url: 'https://peer-b.example.com/' },
        { url: 'https://peer-c.example.com' },
        { url: 'https://self.example.com' },
      ],
    },
    node0Url: 'https://node0.example.com',
    publicUrl: 'https://self.example.com',
  });

  assert.deepEqual(peers, [
    'https://peer-a.example.com',
    'https://peer-b.example.com',
    'https://peer-c.example.com',
    'https://peer-d.example.com',
    'https://peer-e.example.com',
    'https://peer-f.example.com',
  ]);
});

test('media route rate-limits repeated upload attempts before parsing payloads', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-media-rate-'));
  process.env.STREAMCHAIN_NODE_MODE = 'self-hosted';
  process.env.STREAMCHAIN_STORAGE_DIR = rootDir;
  process.env.STREAMCHAIN_RATE_LIMIT_DB = path.join(rootDir, 'rate-limit.sqlite');
  process.env.STREAMCHAIN_MEDIA_UPLOAD_RATE_LIMIT_MAX_REQUESTS = '2';
  process.env.STREAMCHAIN_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS = '60000';

  try {
    const buildRequest = () => {
      const formData = new FormData();
      return new Request('http://localhost/api/node/media', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.10' },
        body: formData,
      });
    };

    const first = await mediaPOST(buildRequest());
    const second = await mediaPOST(buildRequest());
    const third = await mediaPOST(buildRequest());

    assert.equal(first.status, 400);
    assert.equal(second.status, 400);
    assert.equal(third.status, 429);
  } finally {
    delete process.env.STREAMCHAIN_NODE_MODE;
    delete process.env.STREAMCHAIN_STORAGE_DIR;
    delete process.env.STREAMCHAIN_RATE_LIMIT_DB;
    delete process.env.STREAMCHAIN_MEDIA_UPLOAD_RATE_LIMIT_MAX_REQUESTS;
    delete process.env.STREAMCHAIN_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS;
    await rm(rootDir, { recursive: true, force: true });
  }
});


test('health route responds with a minimal healthy payload in node0 mode', async () => {
  delete process.env.STREAMCHAIN_NODE_MODE;
  const response = await healthGET();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'node0');
  assert.ok(payload.checkedAt);
});

test('health route exposes deeper self-hosted readiness checks', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-health-self-hosted-'));
  process.env.STREAMCHAIN_NODE_MODE = 'self-hosted';
  process.env.STREAMCHAIN_STORAGE_DIR = rootDir;
  process.env.STREAMCHAIN_OPERATOR_TOKENS = 'viewer-secret=viewer;id=viewer-1,ops-secret=operator|validator-admin;id=ops-1;expires=2035-01-01T00:00:00Z';

  try {
    const response = await healthGET();
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, 'self-hosted');
    assert.equal(payload.checks.storageDirReadable, true);
    assert.equal(payload.checks.keyStoreDirReadable, true);
    assert.equal(payload.checks.signerConfigured, true);
    assert.equal(payload.checks.operatorTokenConfigured, true);
    assert.equal(payload.operational.writesEnabled, true);
  } finally {
    delete process.env.STREAMCHAIN_NODE_MODE;
    delete process.env.STREAMCHAIN_STORAGE_DIR;
    delete process.env.STREAMCHAIN_OPERATOR_TOKENS;
    await rm(rootDir, { recursive: true, force: true });
  }
});


test('expired or invalid operator token configurations do not count as healthy operator access', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-health-expired-'));
  process.env.STREAMCHAIN_NODE_MODE = 'self-hosted';
  process.env.STREAMCHAIN_STORAGE_DIR = rootDir;
  process.env.STREAMCHAIN_OPERATOR_TOKENS = 'expired-secret=operator;id=expired-1;expires=2000-01-01T00:00:00Z,broken-secret=viewer;id=broken-1;expires=not-a-date';

  try {
    const response = await healthGET();
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.checks.operatorTokenConfigured, false);

    const expiredRequest = new Request('http://localhost/api/node/peers/revoke', {
      headers: { authorization: 'Bearer expired-secret' },
    });
    const expiredAccess = getOperatorAccess(expiredRequest);
    assert.equal(expiredAccess.ok, false);
    assert.equal(expiredAccess.expired, true);

    const brokenRequest = new Request('http://localhost/api/node/audit', {
      headers: { authorization: 'Bearer broken-secret' },
    });
    const brokenAccess = getOperatorAccess(brokenRequest);
    assert.equal(brokenAccess.ok, false);
    assert.equal(brokenAccess.expired, false);
    assert.equal(brokenAccess.configured, true);
  } finally {
    delete process.env.STREAMCHAIN_NODE_MODE;
    delete process.env.STREAMCHAIN_STORAGE_DIR;
    delete process.env.STREAMCHAIN_OPERATOR_TOKENS;
    await rm(rootDir, { recursive: true, force: true });
  }
});


test('operator access supports role-scoped tokens while keeping legacy compatibility', () => {
  process.env.STREAMCHAIN_OPERATOR_TOKENS = 'viewer-secret=viewer;id=viewer-1,ops-secret=operator|validator-admin;id=ops-1;expires=2035-01-01T00:00:00Z';
  process.env.STREAMCHAIN_OPERATOR_TOKEN = 'legacy-super-token';

  try {
    const viewerRequest = new Request('http://localhost/api/node/audit', {
      headers: { authorization: 'Bearer viewer-secret' },
    });
    const viewerAccess = getOperatorAccess(viewerRequest);
    assert.equal(viewerAccess.ok, true);
    assert.equal(viewerAccess.roles.has('viewer'), true);
    assert.equal(viewerAccess.roles.has('operator'), false);

    const denied = assertOperatorAccess(viewerRequest, { requiredRoles: ['operator'] });
    assert.equal(denied.status, 403);

    const opsRequest = new Request('http://localhost/api/node/peers/revoke', {
      headers: { authorization: 'Bearer ops-secret' },
    });
    assert.equal(assertOperatorAccess(opsRequest, { requiredRoles: ['validator-admin'] }), null);

    const legacyRequest = new Request('http://localhost/api/node/link-node0', {
      headers: { authorization: 'Bearer legacy-super-token' },
    });
    const legacyAccess = getOperatorAccess(legacyRequest);
    assert.equal(legacyAccess.roles.has('incident-response'), true);
    assert.equal(assertOperatorAccess(legacyRequest, { requiredRoles: ['incident-response'] }), null);
  } finally {
    delete process.env.STREAMCHAIN_OPERATOR_TOKENS;
    delete process.env.STREAMCHAIN_OPERATOR_TOKEN;
  }
});

test('operator access can enforce an admin origin allowlist when configured', () => {
  process.env.STREAMCHAIN_OPERATOR_TOKENS = 'ops-secret=operator;id=ops-1';
  process.env.STREAMCHAIN_ADMIN_ORIGIN_ALLOWLIST = 'https://ops.example.com,https://admin.example.com';

  try {
    const blockedRequest = new Request('http://localhost/api/node/peers/revoke', {
      headers: {
        authorization: 'Bearer ops-secret',
        origin: 'https://evil.example.com',
      },
    });
    const blocked = assertOperatorAccess(blockedRequest, { requiredRoles: ['operator'] });
    assert.equal(blocked.status, 403);

    const allowedRequest = new Request('http://localhost/api/node/peers/revoke', {
      headers: {
        authorization: 'Bearer ops-secret',
        origin: 'https://ops.example.com',
      },
    });
    assert.equal(assertOperatorAccess(allowedRequest, { requiredRoles: ['operator'] }), null);
  } finally {
    delete process.env.STREAMCHAIN_OPERATOR_TOKENS;
    delete process.env.STREAMCHAIN_ADMIN_ORIGIN_ALLOWLIST;
  }
});


test('rate limit store persists counters in sqlite instead of in-memory only', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-rate-limit-'));
  process.env.STREAMCHAIN_RATE_LIMIT_DB = path.join(rootDir, 'rate-limit.sqlite');

  try {
    const first = await consumeRateLimit('peer:test', { limit: 1, windowMs: 60_000 });
    const second = await consumeRateLimit('peer:test', { limit: 1, windowMs: 60_000 });

    assert.equal(first.allowed, true);
    assert.equal(second.allowed, false);
    assert.ok(second.retryAfterMs > 0);
  } finally {
    delete process.env.STREAMCHAIN_RATE_LIMIT_DB;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('metrics route exposes prometheus-compatible output', async () => {
  const response = await metricsGET();
  const payload = await response.text();

  assert.equal(response.status, 200);
  assert.match(payload, /streamchain_process_uptime_seconds/);
});

test('federation auth signs and verifies asymmetric peer-to-peer request envelopes and rejects replays', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-federation-auth-'));
  process.env.STREAMCHAIN_RATE_LIMIT_DB = path.join(rootDir, 'replay.sqlite');
  process.env.STREAMCHAIN_FEDERATION_ALLOWLIST = 'https://peer-a.example.com';
  const signer = createWalletKeypair();
  const body = JSON.stringify({ state: { chain: [] } });

  try {
    const headers = await createFederationRequestHeaders({
      sourceUrl: 'https://peer-a.example.com',
      body,
      pathname: '/api/node/sync',
      method: 'POST',
      signerPrivateKey: signer.privateKey,
      signerPublicKey: signer.publicKey,
    });
    const request = new Request('http://localhost/api/node/sync', { method: 'POST', headers, body });
    const result = await verifyFederationRequest(request, body, {
      resolveTrustedSignerPublicKey: async (nodeUrl) => (nodeUrl === 'https://peer-a.example.com' ? signer.publicKey : null),
    });

    assert.equal(result.ok, true);
    assert.equal(result.nodeUrl, 'https://peer-a.example.com');
    assert.equal(result.mode, 'signature-v1');
    assert.ok(headers['x-request-id']);

    const replayRequest = new Request('http://localhost/api/node/sync', { method: 'POST', headers, body });
    const replay = await verifyFederationRequest(replayRequest, body, {
      resolveTrustedSignerPublicKey: async (nodeUrl) => (nodeUrl === 'https://peer-a.example.com' ? signer.publicKey : null),
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'Solicitud de federación repetida.');
  } finally {
    delete process.env.STREAMCHAIN_RATE_LIMIT_DB;
    delete process.env.STREAMCHAIN_FEDERATION_ALLOWLIST;
    await rm(rootDir, { recursive: true, force: true });
  }
});


test('request-aware structured logs include request IDs for auth and node0 registration failures', async () => {
  const originalWarn = console.warn;
  const originalLog = console.log;
  const captured = [];
  console.warn = (message) => captured.push({ level: 'warn', payload: JSON.parse(message) });
  console.log = (message) => captured.push({ level: 'info', payload: JSON.parse(message) });

  process.env.STREAMCHAIN_NODE_MODE = 'node0';
  process.env.STREAMCHAIN_NODE0_REGISTRATION_SECRET = 'super-secret';
  process.env.STREAMCHAIN_OPERATOR_TOKENS = 'ops-secret=operator;id=ops-1';
  process.env.STREAMCHAIN_STRUCTURED_LOGS = 'true';

  try {
    const authRequest = new Request('http://localhost/api/node/peers/revoke', {
      headers: { 'x-request-id': 'req-auth-1' },
    });
    const authResponse = assertOperatorAccess(authRequest, { requiredRoles: ['operator'] });
    assert.equal(authResponse.status, 401);

    const registerResponse = await registerPOST(new Request('http://localhost/api/node0/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-register-1' },
      body: JSON.stringify({ url: 'https://peer-valid.example.com' }),
    }));
    assert.equal(registerResponse.status, 400);

    const authLog = captured.find((entry) => entry.payload.event === 'operator_auth_failed');
    assert.equal(authLog.payload.requestId, 'req-auth-1');
    assert.equal(authLog.payload.route, '/api/node/peers/revoke');

    const registerLog = captured.find((entry) => entry.payload.event === 'node0_registration_failed');
    assert.equal(registerLog.payload.requestId, 'req-register-1');
    assert.equal(registerLog.payload.route, '/api/node0/register');
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    delete process.env.STREAMCHAIN_NODE_MODE;
    delete process.env.STREAMCHAIN_NODE0_REGISTRATION_SECRET;
    delete process.env.STREAMCHAIN_OPERATOR_TOKENS;
    delete process.env.STREAMCHAIN_STRUCTURED_LOGS;
  }
});


test('federation auth still supports shared-secret envelopes when asymmetric trust is unavailable', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-federation-hmac-'));
  process.env.STREAMCHAIN_RATE_LIMIT_DB = path.join(rootDir, 'replay.sqlite');
  process.env.STREAMCHAIN_FEDERATION_SHARED_SECRET = 'top-secret-federation';
  process.env.STREAMCHAIN_FEDERATION_ALLOWLIST = 'https://peer-a.example.com';
  const body = JSON.stringify({ state: { chain: [] } });

  try {
    const headers = await createFederationRequestHeaders({
      sourceUrl: 'https://peer-a.example.com',
      body,
      pathname: '/api/node/sync',
      method: 'POST',
    });
    const request = new Request('http://localhost/api/node/sync', { method: 'POST', headers, body });
    const result = await verifyFederationRequest(request, body);

    assert.equal(result.ok, true);
    assert.equal(result.nodeUrl, 'https://peer-a.example.com');
    assert.equal(result.mode, 'hmac-v1');
  } finally {
    delete process.env.STREAMCHAIN_RATE_LIMIT_DB;
    delete process.env.STREAMCHAIN_FEDERATION_SHARED_SECRET;
    delete process.env.STREAMCHAIN_FEDERATION_ALLOWLIST;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('backup and restore scripts create a verifiable backup set for sqlite state and keystore', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-backup-'));
  const storageDir = path.join(rootDir, 'storage');
  const keystoreDir = path.join(rootDir, 'keystore');
  const backupDir = path.join(rootDir, 'backups');
  await mkdir(storageDir, { recursive: true });
  await mkdir(keystoreDir, { recursive: true });
  await mkdir(path.join(storageDir, 'media', 'nested'), { recursive: true });
  await writeFile(path.join(storageDir, 'state.json'), JSON.stringify({ ok: true }), 'utf8');
  await writeFile(path.join(storageDir, 'state.sqlite'), 'sqlite-placeholder', 'utf8');
  await writeFile(path.join(keystoreDir, 'keystore.json'), JSON.stringify({ currentKeyId: 'a', keys: [] }), 'utf8');
  await writeFile(path.join(storageDir, 'media', 'nested', 'proof.txt'), 'media-proof', 'utf8');

  try {
    const env = {
      ...process.env,
      STREAMCHAIN_STORAGE_DIR: storageDir,
      STREAMCHAIN_KEYSTORE_DIR: keystoreDir,
      STREAMCHAIN_BACKUP_DIR: backupDir,
    };
    const backupResult = await execFileAsync(process.execPath, ['./scripts/backup-self-hosted.mjs'], { cwd: process.cwd(), env });
    const backupPayload = JSON.parse(backupResult.stdout.trim());
    const backupId = path.basename(backupPayload.backupDir);
    const manifest = JSON.parse(await readFile(path.join(backupPayload.backupDir, 'manifest.json'), 'utf8'));
    const manifestDigest = (await readFile(path.join(backupPayload.backupDir, 'manifest.sha256'), 'utf8')).trim();

    assert.equal(manifest.manifestVersion, 2);
    assert.ok(manifestDigest.length > 10);
    assert.equal(manifest.mediaFiles[0].file, 'nested/proof.txt');

    await rm(path.join(storageDir, 'state.json'));
    await rm(path.join(storageDir, 'state.sqlite'));
    await rm(path.join(keystoreDir, 'keystore.json'));
    await rm(path.join(storageDir, 'media'), { recursive: true, force: true });

    const restoreResult = await execFileAsync(process.execPath, ['./scripts/restore-self-hosted.mjs', backupId], { cwd: process.cwd(), env });
    const restorePayload = JSON.parse(restoreResult.stdout.trim());

    assert.equal(restorePayload.ok, true);
    assert.equal(restorePayload.manifestVersion, 2);
    assert.ok(JSON.parse(await readFile(path.join(storageDir, 'state.json'), 'utf8')).ok);
    assert.ok(JSON.parse(await readFile(path.join(keystoreDir, 'keystore.json'), 'utf8')).currentKeyId);
    assert.equal(await readFile(path.join(storageDir, 'media', 'nested', 'proof.txt'), 'utf8'), 'media-proof');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('restore script rejects tampered backups before copying files back into storage', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'streamchain-backup-tamper-'));
  const storageDir = path.join(rootDir, 'storage');
  const keystoreDir = path.join(rootDir, 'keystore');
  const backupDir = path.join(rootDir, 'backups');
  await mkdir(storageDir, { recursive: true });
  await mkdir(keystoreDir, { recursive: true });
  await writeFile(path.join(storageDir, 'state.json'), JSON.stringify({ ok: true }), 'utf8');
  await writeFile(path.join(storageDir, 'state.sqlite'), 'sqlite-placeholder', 'utf8');
  await writeFile(path.join(keystoreDir, 'keystore.json'), JSON.stringify({ currentKeyId: 'a', keys: [] }), 'utf8');

  try {
    const env = {
      ...process.env,
      STREAMCHAIN_STORAGE_DIR: storageDir,
      STREAMCHAIN_KEYSTORE_DIR: keystoreDir,
      STREAMCHAIN_BACKUP_DIR: backupDir,
    };
    const backupResult = await execFileAsync(process.execPath, ['./scripts/backup-self-hosted.mjs'], { cwd: process.cwd(), env });
    const backupPayload = JSON.parse(backupResult.stdout.trim());
    const backupId = path.basename(backupPayload.backupDir);

    await writeFile(path.join(backupPayload.backupDir, 'state.sqlite'), 'tampered-content', 'utf8');
    await assert.rejects(
      () => execFileAsync(process.execPath, ['./scripts/restore-self-hosted.mjs', backupId], { cwd: process.cwd(), env }),
      /Hash mismatch/
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
