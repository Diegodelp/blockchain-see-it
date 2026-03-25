import { NextResponse } from 'next/server';
import { getLiveNode0State } from '@/lib/node0';

export const revalidate = 120;

export async function GET() {
  const state = await getLiveNode0State();
  return NextResponse.json(
    {
      network: state.network,
      manifest: state.manifest,
      economics: state.economics || null,
      contact: state.contact || null,
      roadmap: state.roadmap || [],
      references: state.references,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300',
      },
    }
  );
}
