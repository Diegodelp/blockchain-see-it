import { NextResponse } from 'next/server';
import { getBootstrapResponse } from '@/lib/node0';

export const revalidate = 120;

export async function GET() {
  return NextResponse.json(await getBootstrapResponse(), {
    headers: {
      'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300',
    },
  });
}
