import { NextResponse } from 'next/server';

import { assertOperatorAccess, assertRateLimit } from '@/app/api/_lib/security';
import { isSelfHosted } from '@/lib/runtime-config';
import { getAdminAuditTrail } from '@/lib/self-hosted-node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo self-hosted.' }, { status: 403 });
  }

  const authResponse = assertOperatorAccess(request, { requiredRoles: ['viewer', 'operator', 'validator-admin', 'incident-response'] });
  if (authResponse) {
    return authResponse;
  }
  const rateLimitResponse = await assertRateLimit(request, { bucket: 'node-audit-get', limit: 30, windowMs: 60_000 });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 25)));
  const entries = await getAdminAuditTrail();
  return NextResponse.json({
    entries: entries.slice(0, limit),
    total: entries.length,
  });
}
