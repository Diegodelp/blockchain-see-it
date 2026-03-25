import { NextResponse } from 'next/server';

import { getPublicNodeState } from '@/lib/self-hosted-node';
import { isSelfHosted } from '@/lib/runtime-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo self-hosted.' }, { status: 403 });
  }

  return NextResponse.json(await getPublicNodeState());
}
