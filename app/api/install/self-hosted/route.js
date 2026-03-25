import { NextResponse } from 'next/server';

import { createSelfHostedBundle } from '@/lib/install-bundle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const bundle = await createSelfHostedBundle();
    return new NextResponse(bundle, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="streamchain-self-hosted-kit.tar.gz"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || 'No se pudo generar el bundle self-hosted.' },
      { status: 500 }
    );
  }
}
