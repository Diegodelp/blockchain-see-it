import { NextResponse } from 'next/server';

import { createIntegritySnapshot } from '@/lib/integrity';
import { getLiveNode0State } from '@/lib/node0';
import { getPublicBaseUrl, getNodeMode } from '@/lib/runtime-config';
import { getPublicNodeState } from '@/lib/self-hosted-node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_SURFACE = [
  '/api/bootstrap',
  '/api/manifest',
  '/api/chain',
  '/api/integrity',
  '/api/node/export',
  '/api/node/peers',
  '/api/node/sync',
];

export async function GET() {
  const mode = getNodeMode();
  const state = mode === 'self-hosted'
    ? await getPublicNodeState()
    : await getLiveNode0State();

  return NextResponse.json(
    createIntegritySnapshot({
      mode,
      network: state.network,
      manifest: state.manifest,
      chain: state.chain,
      apiSurface: API_SURFACE,
      publicUrl: state.network?.publicUrl || getPublicBaseUrl() || null,
    })
  );
}
