import { NextResponse } from 'next/server';

import { assertOperatorAccess, assertRateLimit } from '@/app/api/_lib/security';
import { isSelfHosted } from '@/lib/runtime-config';
import { revokePeerTrust } from '@/lib/self-hosted-node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo self-hosted.' }, { status: 403 });
  }

  const authResponse = assertOperatorAccess(request, { requiredRoles: ['operator', 'validator-admin', 'incident-response'] });
  if (authResponse) {
    return authResponse;
  }
  const rateLimitResponse = await assertRateLimit(request, { bucket: 'peer-revoke-post', limit: 10, windowMs: 60_000 });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const body = await request.json();
    return NextResponse.json(await revokePeerTrust(body));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
