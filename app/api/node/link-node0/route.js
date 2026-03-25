import { NextResponse } from 'next/server';

import { assertOperatorAccess, assertRateLimit } from '@/app/api/_lib/security';
import { isSelfHosted } from '@/lib/runtime-config';
import { registerWithNode0 } from '@/lib/self-hosted-node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo self-hosted.' }, { status: 403 });
  }

  const authResponse = assertOperatorAccess(request, { requiredRoles: ['operator'] });
  if (authResponse) {
    return authResponse;
  }
  const rateLimitResponse = await assertRateLimit(request, { bucket: 'link-node0-post', limit: 10, windowMs: 60_000 });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const body = await request.json();
    console.log('[streamchain:link-node0] incoming request', {
      node0Url: body.node0Url || null,
      publicUrl: body.publicUrl || null,
      hasRegistrationSecret: Boolean(body.registrationSecret),
    });
    return NextResponse.json(await registerWithNode0(body));
  } catch (error) {
    console.error('[streamchain:link-node0] request failed', {
      message: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
