import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { signConsensusPayload, verifyConsensusSignature } from '@/lib/chain-security';
import { getRequestId, getRequestLogContext, incrementCounter, logEvent } from '@/lib/observability';
import { rememberFederationReplayKey } from '@/lib/rate-limit-store';
import { getFederationAllowedPeers, getFederationSharedSecret } from '@/lib/runtime-config';

const FEDERATION_MAX_CLOCK_SKEW_MS = 60_000;
const FEDERATION_REPLAY_TTL_MS = 5 * 60_000;

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function buildFederationEnvelope({ nodeUrl, timestamp, nonce, method, pathname, bodyHash }) {
  return {
    nodeUrl: normalizeUrl(nodeUrl),
    timestamp: String(timestamp || ''),
    nonce: String(nonce || ''),
    method: String(method || 'POST').toUpperCase(),
    pathname: String(pathname || ''),
    bodyHash: String(bodyHash || ''),
  };
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function assertReplayWindow({ nodeUrl, timestamp, nonce }) {
  const timestampMs = new Date(timestamp || 0).getTime();
  const timestampDelta = Math.abs(Date.now() - timestampMs);
  if (!Number.isFinite(timestampMs) || timestampDelta > FEDERATION_MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'timestamp' };
  }

  if (!nonce || String(nonce).length < 16) {
    return { ok: false, reason: 'nonce' };
  }

  const replayKey = `federation:${normalizeUrl(nodeUrl)}:${nonce}`;
  const registered = await rememberFederationReplayKey(replayKey, { ttlMs: FEDERATION_REPLAY_TTL_MS });
  if (!registered.ok) {
    return { ok: false, reason: 'replay' };
  }

  return { ok: true };
}

export async function createFederationRequestHeaders({
  sourceUrl,
  body,
  pathname = '',
  method = 'POST',
  signerPrivateKey = null,
  signerPublicKey = null,
  requestId = randomUUID(),
}) {
  const normalizedUrl = normalizeUrl(sourceUrl);
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const bodyHash = sha256(body || '');
  const envelope = buildFederationEnvelope({
    nodeUrl: normalizedUrl,
    timestamp,
    nonce,
    method,
    pathname,
    bodyHash,
  });
  const headers = {
    'x-streamchain-federation-node': normalizedUrl,
    'x-streamchain-federation-ts': timestamp,
    'x-streamchain-federation-nonce': nonce,
    'x-streamchain-federation-body-sha256': bodyHash,
    'x-streamchain-federation-method': envelope.method,
    'x-streamchain-federation-path': envelope.pathname,
    'x-request-id': requestId,
  };

  if (signerPrivateKey && signerPublicKey) {
    const signature = signConsensusPayload(envelope, signerPrivateKey);
    return {
      ...headers,
      'x-streamchain-federation-signer': signerPublicKey,
      'x-streamchain-federation-signature': signature,
      'x-streamchain-federation-auth-mode': 'signature-v1',
    };
  }

  const sharedSecret = getFederationSharedSecret();
  if (!sharedSecret) {
    return headers;
  }

  const signature = createHmac('sha256', sharedSecret)
    .update(`${normalizedUrl}:${timestamp}:${nonce}:${envelope.method}:${envelope.pathname}:${bodyHash}`)
    .digest('hex');

  return {
    ...headers,
    'x-streamchain-federation-signature': signature,
    'x-streamchain-federation-auth-mode': 'hmac-v1',
  };
}

export async function verifyFederationRequest(request, bodyText, options = {}) {
  const nodeUrl = normalizeUrl(request.headers.get('x-streamchain-federation-node'));
  const timestamp = request.headers.get('x-streamchain-federation-ts') || '';
  const nonce = request.headers.get('x-streamchain-federation-nonce') || '';
  const bodyHash = request.headers.get('x-streamchain-federation-body-sha256') || '';
  const signature = request.headers.get('x-streamchain-federation-signature') || '';
  const signerPublicKey = request.headers.get('x-streamchain-federation-signer') || '';
  const headerMethod = (request.headers.get('x-streamchain-federation-method') || request.method || 'POST').toUpperCase();
  const headerPath = request.headers.get('x-streamchain-federation-path') || new URL(request.url).pathname;
  const expectedBodyHash = sha256(bodyText || '');
  const allowedPeers = getFederationAllowedPeers();
  const requestId = getRequestId(request);

  if (allowedPeers.length > 0 && (!nodeUrl || !allowedPeers.includes(nodeUrl))) {
    incrementCounter('streamchain_federation_auth_failures_total', { reason: 'allowlist' });
    logEvent('warn', 'federation_auth_failed', getRequestLogContext(request, { requestId, reason: 'allowlist', nodeUrl }));
    return { ok: false, reason: 'El peer no está permitido por la allowlist de federación.' };
  }

  if (!nodeUrl || !timestamp || !nonce || !signature || bodyHash !== expectedBodyHash) {
    incrementCounter('streamchain_federation_auth_failures_total', { reason: 'signature' });
    logEvent('warn', 'federation_auth_failed', getRequestLogContext(request, { requestId, reason: 'signature', nodeUrl }));
    return { ok: false, reason: 'Firma de federación inválida o incompleta.' };
  }

  const replayWindow = await assertReplayWindow({ nodeUrl, timestamp, nonce });
  if (!replayWindow.ok) {
    incrementCounter('streamchain_federation_auth_failures_total', { reason: replayWindow.reason });
    logEvent('warn', 'federation_auth_failed', getRequestLogContext(request, { requestId, reason: replayWindow.reason, nodeUrl }));
    return { ok: false, reason: replayWindow.reason === 'replay' ? 'Solicitud de federación repetida.' : 'Firma de federación inválida o expirada.' };
  }

  const envelope = buildFederationEnvelope({
    nodeUrl,
    timestamp,
    nonce,
    method: headerMethod,
    pathname: headerPath,
    bodyHash: expectedBodyHash,
  });

  if (signerPublicKey) {
    const trustedSignerPublicKey = await options.resolveTrustedSignerPublicKey?.(nodeUrl);
    if (!trustedSignerPublicKey || trustedSignerPublicKey !== signerPublicKey || !verifyConsensusSignature(envelope, trustedSignerPublicKey, signature)) {
      incrementCounter('streamchain_federation_auth_failures_total', { reason: 'signature' });
      logEvent('warn', 'federation_auth_failed', getRequestLogContext(request, { requestId, reason: 'signature', nodeUrl, authMode: 'signature-v1' }));
      return { ok: false, reason: 'Firma asimétrica de federación inválida.' };
    }

    return { ok: true, nodeUrl, mode: 'signature-v1', signerPublicKey };
  }

  const sharedSecret = getFederationSharedSecret();
  if (!sharedSecret) {
    incrementCounter('streamchain_federation_auth_failures_total', { reason: 'disabled' });
    logEvent('warn', 'federation_auth_failed', getRequestLogContext(request, { requestId, reason: 'disabled', nodeUrl }));
    return { ok: false, reason: 'La autenticación de federación no está configurada.' };
  }

  const expectedSignature = createHmac('sha256', sharedSecret)
    .update(`${nodeUrl}:${timestamp}:${nonce}:${envelope.method}:${envelope.pathname}:${expectedBodyHash}`)
    .digest('hex');

  if (!constantTimeEqual(signature, expectedSignature)) {
    incrementCounter('streamchain_federation_auth_failures_total', { reason: 'signature' });
    logEvent('warn', 'federation_auth_failed', getRequestLogContext(request, { requestId, reason: 'signature', nodeUrl, authMode: 'hmac-v1' }));
    return { ok: false, reason: 'Firma de federación inválida o expirada.' };
  }

  return { ok: true, nodeUrl, mode: 'hmac-v1' };
}
