import { NextResponse } from 'next/server';

import { assertRateLimit } from '@/app/api/_lib/security';
import { isValidChain } from '@/lib/chain-security';
import { upsertRegisteredPeer, readRegisteredPeers } from '@/lib/node0-registry';
import { getRequestLogContext, logEvent } from '@/lib/observability';
import { getNode0RegistrationSecret, isSelfHosted } from '@/lib/runtime-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizePeerUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function verifyRemoteNode(url, requestContext) {
  logEvent('info', 'node0_registration_verification_started', { ...requestContext, peerUrl: url });
  const exportResponse = await fetch(`${url}/api/node/export`, { cache: 'no-store' });
  logEvent('info', 'node0_registration_probe', { ...requestContext, peerUrl: url, probe: 'export', status: exportResponse.status, ok: exportResponse.ok });
  if (!exportResponse.ok) {
    throw new Error(`/api/node/export returned HTTP ${exportResponse.status}`);
  }

  const remoteState = await exportResponse.json();
  if (remoteState.network?.role !== 'self-hosted-full-node') {
    throw new Error(`Expected self-hosted-full-node but received ${remoteState.network?.role || 'unknown'}`);
  }
  if (!remoteState.network?.nodeSignerPublicKey) {
    throw new Error('Remote node did not expose nodeSignerPublicKey.');
  }

  if (!isValidChain(remoteState.chain || [], {
    requireSignatures: true,
    expectedSignerPublicKey: remoteState.network.nodeSignerPublicKey,
  })) {
    throw new Error('Remote chain failed validation.');
  }

  const manifestResponse = await fetch(`${url}/api/manifest`, { cache: 'no-store' });
  logEvent('info', 'node0_registration_probe', { ...requestContext, peerUrl: url, probe: 'manifest', status: manifestResponse.status, ok: manifestResponse.ok });
  if (!manifestResponse.ok) {
    throw new Error(`/api/manifest returned HTTP ${manifestResponse.status}`);
  }

  const manifestState = await manifestResponse.json();
  const integrityResponse = await fetch(`${url}/api/integrity`, { cache: 'no-store' });
  logEvent('info', 'node0_registration_probe', { ...requestContext, peerUrl: url, probe: 'integrity', status: integrityResponse.status, ok: integrityResponse.ok });
  if (!integrityResponse.ok) {
    throw new Error(`/api/integrity returned HTTP ${integrityResponse.status}`);
  }

  const integrityState = await integrityResponse.json();
  if (!integrityState.integrityHash) {
    throw new Error('Remote node did not provide an integrity hash.');
  }
  if (String(integrityState.publicUrl || '').replace(/\/+$/, '') !== url) {
    throw new Error('Remote integrity publicUrl does not match the submitted URL.');
  }

  return {
    role: remoteState.network.role,
    chainHeight: Array.isArray(remoteState.chain) ? remoteState.chain.length : 0,
    lastBlockHash: remoteState.chain?.at?.(-1)?.hash || null,
    capabilities: manifestState.manifest?.capabilities || [],
    integrityHash: integrityState.integrityHash,
    integrityMode: integrityState.mode || 'unknown',
    publicUrl: integrityState.publicUrl || null,
    signerPublicKey: remoteState.network.nodeSignerPublicKey,
  };
}

function getAuthorizationMode(request) {
  const configuredSecret = getNode0RegistrationSecret();
  if (!configuredSecret) {
    return 'public-verified';
  }

  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const headerSecret = request.headers.get('x-streamchain-registration-secret') || '';
  if (bearer === configuredSecret || headerSecret === configuredSecret) {
    return 'secret';
  }

  throw new Error('Registration secret inválido o ausente.');
}

export async function GET() {
  if (isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo node0.' }, { status: 403 });
  }

  return NextResponse.json({
    peers: await readRegisteredPeers(),
  });
}

export async function POST(request) {
  if (isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo node0.' }, { status: 403 });
  }

  const rateLimitResponse = await assertRateLimit(request, { bucket: 'node0-register-post', limit: 12, windowMs: 60_000 });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const requestContext = getRequestLogContext(request);
    const authorizationMode = getAuthorizationMode(request);
    const body = await request.json();
    logEvent('info', 'node0_registration_received', {
      ...requestContext,
      authorizationMode,
      peerUrl: body.url || null,
      source: body.source || null,
      tunnel: body.tunnel || null,
      hasIntegrityHash: Boolean(body.integrityHash),
    });
    const url = normalizePeerUrl(body.url);
    if (!url) {
      throw new Error('Debes enviar una URL pública del nodo self-hosted.');
    }

    const verification = await verifyRemoteNode(url, requestContext);
    if (body.integrityHash && body.integrityHash !== verification.integrityHash) {
      logEvent('warn', 'node0_registration_integrity_mismatch', {
        ...requestContext,
        claimedIntegrityHash: body.integrityHash,
        remoteIntegrityHash: verification.integrityHash,
        peerUrl: url,
      });
      throw new Error('Claimed integrityHash does not match the remote integrity fingerprint.');
    }

    const registeredAt = new Date().toISOString();
    const peer = {
      url,
      role: verification.role,
      status: 'verified',
      source: body.source || 'self-registration',
      authorizationMode,
      tunnel: body.tunnel || null,
      registeredAt,
      verifiedAt: registeredAt,
      chainHeight: verification.chainHeight,
      lastBlockHash: verification.lastBlockHash,
      capabilities: verification.capabilities,
      integrityHash: verification.integrityHash,
      integrityMode: verification.integrityMode,
      publicUrl: verification.publicUrl,
      signerPublicKey: verification.signerPublicKey,
    };

    await upsertRegisteredPeer(peer);
    logEvent('info', 'node0_registration_accepted', {
      ...requestContext,
      peerUrl: peer.url,
      authorizationMode: peer.authorizationMode,
      integrityMode: peer.integrityMode,
      publicUrl: peer.publicUrl,
    });
    return NextResponse.json({
      ok: true,
      peer,
      message: 'Peer auto-registrado y verificado en node0.',
    });
  } catch (error) {
    logEvent('warn', 'node0_registration_failed', {
      ...getRequestLogContext(request),
      message: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
