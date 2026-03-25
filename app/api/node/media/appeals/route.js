import { NextResponse } from 'next/server';

import { isSelfHosted } from '@/lib/runtime-config';
import { openModerationAppeal } from '@/lib/self-hosted-node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo self-hosted.' }, { status: 403 });
  }

  try {
    const body = await request.json();
    return NextResponse.json(await openModerationAppeal(body));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
