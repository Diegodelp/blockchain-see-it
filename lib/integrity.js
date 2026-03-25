import { createHash } from 'crypto';

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

export function createIntegritySnapshot({ mode, network, manifest, chain, apiSurface, publicUrl }) {
  const payload = {
    mode,
    role: network?.role || 'unknown',
    deployment: network?.deployment || 'unknown',
    nodeSignerPublicKey: network?.nodeSignerPublicKey || null,
    capabilities: manifest?.capabilities || [],
    monetization: manifest?.monetization || [],
    apiSurface: apiSurface || [],
    chainHeight: Array.isArray(chain) ? chain.length : 0,
    bootstrapHash: Array.isArray(chain) && chain.length > 0 ? chain.at(-1)?.hash || null : null,
    publicUrl: publicUrl || null,
    integrityVersion: 1,
  };

  return {
    ...payload,
    integrityHash: createHash('sha256').update(stableStringify(payload)).digest('hex'),
  };
}
