import { unstable_noStore as noStore } from 'next/cache';

import { getBootstrapResponse, getLiveNode0State } from '@/lib/node0';
import { getNodeMode } from '@/lib/runtime-config';
import { getPublicNodeState } from '@/lib/self-hosted-node';

export async function getAppState() {
  noStore();
  const mode = getNodeMode();
  if (mode === 'self-hosted') {
    return {
      mode,
      state: await getPublicNodeState(),
    };
  }

  const state = await getLiveNode0State();
  return {
    mode,
    state,
    bootstrap: await getBootstrapResponse(),
    references: state.references,
  };
}
