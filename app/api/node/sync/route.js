import { NextResponse } from 'next/server';

import { verifyFederationRequest } from '@/app/api/_lib/federation-auth';
import { assertOperatorToken, assertRateLimit } from '@/app/api/_lib/security';
import { ingestRemoteState, resolveFederationTrustedSignerPublicKey } from '@/lib/self-hosted-node';
import { isSelfHosted } from '@/lib/runtime-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo self-hosted.' }, { status: 403 });
  }

  const rateLimitResponse = await assertRateLimit(request, { bucket: 'node-sync-post', limit: 30, windowMs: 60_000 });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const rawBody = await request.text();
    const federationAuth = await verifyFederationRequest(request, rawBody, {
      resolveTrustedSignerPublicKey: resolveFederationTrustedSignerPublicKey,
    });
    if (!federationAuth.ok) {
      const operatorAuthResponse = assertOperatorToken(request);
      if (operatorAuthResponse) {
        return NextResponse.json({ error: federationAuth.reason }, { status: 401 });
      }
    }
    const body = JSON.parse(rawBody || '{}');
    return NextResponse.json(await ingestRemoteState(body));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
