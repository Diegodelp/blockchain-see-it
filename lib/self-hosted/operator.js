export function createOperatorApi(ctx) {
  const {
    getGenesisNode0Url,
    getPublicBaseUrl,
    normalizePeerUrl,
    readState,
    writeState,
    getIntegritySnapshot,
    fetchAdvertisedIntegritySnapshot,
    registerPeer,
    getPublicNodeState,
    recordAdminAction,
  } = ctx;

  function safeParseJson(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  async function registerWithNode0({ node0Url, registrationSecret, publicUrl }) {
    const normalizedNode0Url = normalizePeerUrl(node0Url || getGenesisNode0Url());
    const normalizedPublicUrl = normalizePeerUrl(publicUrl || getPublicBaseUrl());

    console.log('[streamchain:self-hosted] registerWithNode0:start', {
      node0Url: normalizedNode0Url,
      publicUrl: normalizedPublicUrl,
      hasRegistrationSecret: Boolean(registrationSecret?.trim()),
    });

    if (!normalizedNode0Url) {
      throw new Error('Debes ingresar la URL pública de node0.');
    }

    if (!normalizedPublicUrl) {
      throw new Error('Debes ingresar la URL pública de este nodo (o definir STREAMCHAIN_PUBLIC_URL).');
    }
    if (normalizedPublicUrl === normalizedNode0Url) {
      throw new Error('La URL pública de este nodo no puede ser la misma URL de node0. Usa tu URL de ngrok/cloudflared para este nodo.');
    }

    const state = await readState();
    if (state.network.publicUrl !== normalizedPublicUrl) {
      state.network = {
        ...state.network,
        publicUrl: normalizedPublicUrl,
        publicUrlUpdatedAt: new Date().toISOString(),
      };
      recordAdminAction(state, {
        action: 'node0_public_url_updated',
        targetType: 'network',
        targetId: normalizedPublicUrl,
        reason: 'Public URL updated during node0 registration flow.',
        status: 'accepted',
        metadata: { node0Url: normalizedNode0Url },
      });
      await writeState(state);
      console.log('[streamchain:self-hosted] registerWithNode0:public-url-persisted', {
        publicUrl: normalizedPublicUrl,
      });
    }

    const integrity = getIntegritySnapshot(state);
    const advertisedIntegrity = await fetchAdvertisedIntegritySnapshot(normalizedPublicUrl);
    console.log('[streamchain:self-hosted] registerWithNode0:integrity-ready', {
      localIntegrityHash: integrity.integrityHash,
      advertisedIntegrityHash: advertisedIntegrity.integrityHash || null,
    });
    const integrityHashesMatch = !advertisedIntegrity.integrityHash ||
      advertisedIntegrity.integrityHash === integrity.integrityHash;
    if (!integrityHashesMatch) {
      console.warn('[streamchain:self-hosted] registerWithNode0:integrity-mismatch-warning', {
        localIntegrityHash: integrity.integrityHash,
        advertisedIntegrityHash: advertisedIntegrity.integrityHash,
        note: 'Continuing registration without claimed integrityHash to avoid false negatives behind tunnels.',
      });
    }
    await registerPeer({ url: normalizedNode0Url });
    console.log('[streamchain:self-hosted] registerWithNode0:node0-linked-readonly', {
      node0Url: normalizedNode0Url,
    });

    const headers = {
      'Content-Type': 'application/json',
    };

    if (registrationSecret?.trim()) {
      headers.Authorization = `Bearer ${registrationSecret.trim()}`;
    }

    const registrationBody = {
      url: normalizedPublicUrl,
      source: 'guided-ui',
      tunnel: normalizedPublicUrl.includes('ngrok') ? 'ngrok' : null,
      integrityHash: integrityHashesMatch ? (advertisedIntegrity.integrityHash || integrity.integrityHash) : undefined,
    };

    const response = await fetch(`${normalizedNode0Url}/api/node0/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify(registrationBody),
    });

    const rawPayload = await response.text();
    const parsedPayload = safeParseJson(rawPayload);
    const payload = parsedPayload || {};
    console.log('[streamchain:self-hosted] registerWithNode0:node0-response', {
      status: response.status,
      ok: response.ok,
      payload: parsedPayload || rawPayload || null,
    });
    const nextState = await readState();
    if (!response.ok) {
      const failureReason = payload.error || rawPayload || `node0 respondió HTTP ${response.status}`;
      nextState.network = {
        ...nextState.network,
        node0Registration: {
          node0Url: normalizedNode0Url,
          status: 'failed',
          updatedAt: new Date().toISOString(),
          message: failureReason,
        },
      };
      recordAdminAction(nextState, {
        action: 'node0_registration_failed',
        targetType: 'node0',
        targetId: normalizedNode0Url,
        reason: failureReason,
        status: 'failed',
        metadata: { publicUrl: normalizedPublicUrl },
      });
      await writeState(nextState);
      return {
        state: await getPublicNodeState(),
        registration: null,
        warning: failureReason,
        message: 'Este nodo quedó linkeado con node0 para discovery/bootstrap, pero el anuncio opcional en /api/node0/register falló.',
      };
    }

    nextState.network = {
      ...nextState.network,
      node0Registration: {
        node0Url: normalizedNode0Url,
        status: 'registered',
        updatedAt: new Date().toISOString(),
        message: 'Registro aceptado por node0.',
        authorizationMode: payload.peer?.authorizationMode || null,
        publicUrl: normalizedPublicUrl,
      },
    };
    recordAdminAction(nextState, {
      action: 'node0_registration_completed',
      targetType: 'node0',
      targetId: normalizedNode0Url,
      reason: 'Node registered successfully with node0.',
      status: 'accepted',
      metadata: {
        publicUrl: normalizedPublicUrl,
        authorizationMode: payload.peer?.authorizationMode || null,
      },
    });
    await writeState(nextState);

    return {
      state: await getPublicNodeState(),
      registration: payload.peer || null,
      message: 'Este nodo quedó linkeado con node0 y fue enviado a su registro público.',
    };
  }

  return { registerWithNode0 };
}
