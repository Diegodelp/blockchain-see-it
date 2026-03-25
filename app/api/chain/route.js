import { NextResponse } from 'next/server';
import { getLiveNode0State } from '@/lib/node0';

export const revalidate = 120;

export async function GET() {
  const state = await getLiveNode0State();
  return NextResponse.json(
    {
      chain: state.chain,
      featuredVideos: state.featuredVideos,
      listings: state.listings || [],
      references: state.references,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300',
      },
    }
  );
}
