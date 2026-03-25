import { NextResponse } from 'next/server';

import { attestValidatorHumanity, registerValidatorHumanity } from '@/lib/self-hosted-node';
import { isSelfHosted } from '@/lib/runtime-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo self-hosted.' }, { status: 403 });
  }

  try {
    const body = await request.json();
    if (body?.action === 'attest') {
      return NextResponse.json(await attestValidatorHumanity(body));
    }
    return NextResponse.json(await registerValidatorHumanity(body));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
