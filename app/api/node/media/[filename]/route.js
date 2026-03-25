import { NextResponse } from 'next/server';

import { readMediaFile } from '@/lib/self-hosted-node';
import { isSelfHosted } from '@/lib/runtime-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo self-hosted.' }, { status: 403 });
  }

  try {
    const buffer = await readMediaFile(params.filename);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Archivo no encontrado.' }, { status: 404 });
  }
}
