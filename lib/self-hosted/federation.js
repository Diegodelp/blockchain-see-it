import { createFederationRequestHeaders } from '@/app/api/_lib/federation-auth';

export function createFederationApi(ctx) {
  const {
    exportNodeState,
    getPublicBaseUrl,
    normalizePeerUrl,
    getTrustedPeerSignerEntry,
    upsertPeerRegistryEntry,
    getNode0RegistrationTargets,
    getNode0RegistrationSecret,
    getIntegritySnapshot,
    sortUnique,
    validateConsensusStateView,
    isValidChain,
    getPinnedPeerSigner,
    recordChainObservation,
    mergeChainObservations,
    mergeHeadEndorsements,
    mergePeerAnnouncements,
    getTrustedObserverCountForHead,
    getRequiredHeadQuorum,
    appendConsensusEvidence,
    sanitizeConsensusRegistryEntry,
    mergeById,
    filterSignedTransactions,
    hasReplayConflict,
    ensureWalletNonce,
    readState,
    writeState,
    getPublicNodeState,
    recordTrustedPeerSigner,
    revokeTrustedPeer,
    verifyPeerAnnouncement,
    isPeerAnnouncementFresh,
    getAcceptedSyncPeerSignerMap,
    normalizeIsoDate,
    recordAdminAction,
  } = ctx;

  async function broadcastState(state) {
    const peers = state.peers || [];
    const exportedState = exportNodeState(state);
    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        const endpoint = `${peer}/api/node/sync`;
        const body = JSON.stringify({ state: exportedState });
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...await createFederationRequestHeaders({
              sourceUrl: state.network?.publicUrl || getPublicBaseUrl(),
              body,
              pathname: '/api/node/sync',
              method: 'POST',
              signerPrivateKey: state.network?.nodeSignerPrivateKey || null,
              signerPublicKey: state.network?.nodeSignerPublicKey || null,
            }),
          },
          body,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return {
          url: peer,
          syncedAt: new Date().toISOString(),
          lastBlockHash: state.chain.at(-1)?.hash ?? null,
        };
      })
    );

    let nextRegistry = state.peerRegistry || [];
    results.forEach((result, index) => {
      const url = peers[index];
      if (result.status === 'fulfilled') {
        const trustedSigner = getTrustedPeerSignerEntry(state, url);
        nextRegistry = upsertPeerRegistryEntry(nextRegistry, {
          url,
          linkStatus: 'linked',
          syncStatus: 'synchronized',
          syncCapable: true,
          lastCheckedAt: result.value.syncedAt,
          lastSyncedAt: result.value.syncedAt,
          lastBlockHash: result.value.lastBlockHash,
          lastValidatedAt: result.value.syncedAt,
          note: trustedSigner?.trustStatus === 'rotation-pending'
            ? 'Remote sync accepted, but signer rotation approval is still pending.'
            : 'Remote sync accepted.',
        });
        return;
      }

      nextRegistry = upsertPeerRegistryEntry(nextRegistry, {
        url,
        linkStatus: 'linked',
        syncStatus: 'sync-error',
        syncCapable: true,
        lastCheckedAt: new Date().toISOString(),
        note: result.reason?.message || 'Remote sync failed.',
      });
    });

    state.peerRegistry = nextRegistry;
  }

  async function announceNodePresence(state, options = {}) {
    const publicUrl = normalizePeerUrl(getPublicBaseUrl());
    if (!publicUrl) {
      return;
    }

    const integrity = getIntegritySnapshot(state);
    const tunnel = publicUrl.includes('ngrok') ? 'ngrok' : null;
    const selfHostedTargets = sortUnique((state.peers || []).filter((peer) => normalizePeerUrl(peer) !== publicUrl));
    const node0Targets = sortUnique([
      ...getNode0RegistrationTargets(),
      options.includeNode0Url ? normalizePeerUrl(options.includeNode0Url) : '',
    ]);

    await Promise.allSettled([
      ...selfHostedTargets.map(async (peer) => {
        const body = JSON.stringify({
          url: publicUrl,
          integrityHash: integrity.integrityHash,
        });
        return fetch(`${peer}/api/node/peers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...await createFederationRequestHeaders({
              sourceUrl: publicUrl,
              body,
              pathname: '/api/node/peers',
              method: 'POST',
              signerPrivateKey: state.network?.nodeSignerPrivateKey || null,
              signerPublicKey: state.network?.nodeSignerPublicKey || null,
            }),
          },
          body,
        });
      }),
      ...node0Targets.map((target) => {
        const secret = getNode0RegistrationSecret();
        return fetch(`${target}/api/node0/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify({
            url: publicUrl,
            source: 'self-hosted-auto-announce',
            tunnel,
            integrityHash: integrity.integrityHash,
          }),
        });
      }),
    ]);
  }

  async function probePeerUrl(peerUrl) {
    const exportResponse = await fetch(`${peerUrl}/api/node/export`, { cache: 'no-store' }).catch((error) => error);
    if (exportResponse instanceof Error) {
      throw exportResponse;
    }

    if (exportResponse.ok) {
      const remoteState = await exportResponse.json();
      const remoteSignerPublicKey = remoteState.network?.nodeSignerPublicKey || null;
      if (!remoteSignerPublicKey) {
        throw new Error(`The remote peer ${peerUrl} did not expose a node signer public key.`);
      }
      if (!isValidChain(remoteState.chain || [], { requireSignatures: true, expectedSignerPublicKey: remoteSignerPublicKey })) {
        throw new Error(`Signed chain verification failed for ${peerUrl}.`);
      }
      if (!validateConsensusStateView(remoteState)) {
        throw new Error(`Consensus finality verification failed for ${peerUrl}.`);
      }
      const integrityResponse = await fetch(`${peerUrl}/api/integrity`, { cache: 'no-store' }).catch((error) => error);
      if (integrityResponse instanceof Error || !integrityResponse.ok) {
        throw new Error(`Integrity verification failed for ${peerUrl}.`);
      }
      const integrityState = await integrityResponse.json();
      return {
        kind: 'self-hosted',
        remoteState,
        role: remoteState.network?.role || 'self-hosted-full-node',
        lastBlockHash: remoteState.chain?.at?.(-1)?.hash || null,
        integrityHash: integrityState.integrityHash || null,
        signerPublicKey: remoteSignerPublicKey,
        note: 'Linked and initial state imported from /api/node/export after integrity verification.',
      };
    }

    const manifestResponse = await fetch(`${peerUrl}/api/manifest`, { cache: 'no-store' }).catch((error) => error);
    if (manifestResponse instanceof Error) {
      throw manifestResponse;
    }

    if (manifestResponse.ok) {
      const manifestState = await manifestResponse.json();
      const integrityResponse = await fetch(`${peerUrl}/api/integrity`, { cache: 'no-store' }).catch((error) => error);
      if (integrityResponse instanceof Error || !integrityResponse.ok) {
        throw new Error(`Integrity verification failed for ${peerUrl}.`);
      }
      const integrityState = await integrityResponse.json();
      return {
        kind: 'read-only',
        role: manifestState.network?.role || 'public-node0',
        lastBlockHash: null,
        integrityHash: integrityState.integrityHash || null,
        note: 'Linked as public read-only reference after integrity verification. This URL does not expose /api/node/export, so bidirectional sync is not available.',
      };
    }

    return {
      kind: 'unsupported',
      role: 'unknown',
      lastBlockHash: null,
      note: `Unsupported StreamChain endpoint. /api/node/export returned HTTP ${exportResponse.status} and /api/manifest returned HTTP ${manifestResponse.status}. If this is a protected Vercel preview deployment, use the public production URL or disable deployment protection for server-to-server checks.`,
    };
  }

  function mergeRemoteState(localState, remoteState) {
    const merged = structuredClone(localState);
    const remoteChain = remoteState.chain || [];
    const localChain = merged.chain || [];
    const remoteUrl = normalizePeerUrl(remoteState?.network?.publicUrl);
    const trustedRemoteSigner = getPinnedPeerSigner(localState, remoteState);
    const remoteHeadHash = remoteChain.at(-1)?.hash || null;
    const remoteConsensusValid = validateConsensusStateView(remoteState);

    if (remoteUrl && remoteState?.network?.nodeSignerPublicKey && remoteHeadHash) {
      recordChainObservation(merged, {
        url: remoteUrl,
        signerPublicKey: remoteState.network.nodeSignerPublicKey,
        headHash: remoteHeadHash,
        observedAt: new Date().toISOString(),
        source: 'remote-export',
      });
    }

    mergeChainObservations(merged, remoteState?.chainConsensus?.observations || []);
    mergeHeadEndorsements(merged, remoteState?.chainConsensus?.headEndorsements || []);
    mergePeerAnnouncements(merged, remoteState?.chainConsensus?.peerAnnouncements || []);

    const isPrefixExtension = (
      remoteChain.length > localChain.length &&
      localChain.every((block, index) => remoteChain[index]?.hash === block.hash)
    );
    const trustedObserverCount = remoteHeadHash ? getTrustedObserverCountForHead(merged, remoteHeadHash) : 0;
    const requiredHeadQuorum = getRequiredHeadQuorum(merged);

    if (
      trustedRemoteSigner &&
      remoteConsensusValid &&
      isValidChain(remoteChain, { requireSignatures: true, expectedSignerPublicKey: trustedRemoteSigner }) &&
      isPrefixExtension &&
      trustedObserverCount >= requiredHeadQuorum
    ) {
      merged.chain = remoteChain;
      merged.consensus = {
        ...(merged.consensus || {}),
        ...(remoteState.chainConsensus
          ? {
            validatorSetHash: remoteState.chainConsensus.validatorSetHash || merged.consensus?.validatorSetHash || null,
            lastFinalizedBlockHash: remoteState.chainConsensus.lastFinalizedBlockHash || remoteHeadHash,
            validatorRegistry: (remoteState.chainConsensus.validatorRegistry || []).map((entry) => sanitizeConsensusRegistryEntry(entry)),
            epochChanges: remoteState.chainConsensus.epochChanges || merged.consensus?.epochChanges || [],
            evidence: remoteState.chainConsensus.evidence || merged.consensus?.evidence || [],
            slashingEvents: remoteState.chainConsensus.slashingEvents || merged.consensus?.slashingEvents || [],
            peerAnnouncements: merged.consensus?.peerAnnouncements || [],
            currentEpoch: Number(remoteState.chainConsensus.currentEpoch || merged.consensus?.currentEpoch || 1),
            currentRound: Number(remoteState.chainConsensus.currentRound || merged.consensus?.currentRound || 0),
          }
          : {}),
      };
    } else if (!remoteConsensusValid && remoteHeadHash) {
      appendConsensusEvidence(merged, {
        type: 'invalidProposalEvidence',
        validatorAddress: null,
        offender: remoteUrl || remoteState?.network?.role || 'remote-peer',
        blockHash: remoteHeadHash,
        height: Number(remoteChain.at(-1)?.height || remoteChain.length - 1),
        round: Number(remoteChain.at(-1)?.round || 0),
        epoch: Number(remoteChain.at(-1)?.epoch || 0),
        phase: 'remote-sync',
        details: {
          reason: 'Rejected remote chain because consensus finality could not be verified.',
        },
        slashed: false,
      });
    }

    merged.featuredVideos = mergeById(
      merged.featuredVideos.map((item) => ({ id: item.proof, ...item })),
      (remoteState.featuredVideos || []).map((item) => ({ id: item.proof, ...item })),
      'id'
    ).map(({ id, ...item }) => item);

    merged.rejectedVideos = mergeById(merged.rejectedVideos || [], remoteState.rejectedVideos || [], 'id')
      .sort((left, right) => new Date(right.finalizedAt) - new Date(left.finalizedAt));

    merged.pendingVideos = mergeById(merged.pendingVideos, remoteState.pendingVideos || [], 'id')
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    merged.moderationCases = mergeById(merged.moderationCases || [], remoteState.moderationCases || [], 'caseId')
      .sort((left, right) => new Date(right.openedAt || 0) - new Date(left.openedAt || 0));

    merged.listings = mergeById(merged.listings || [], remoteState.listings || [], 'id')
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));

    merged.wallets = mergeById(merged.wallets, remoteState.wallets || [], 'address');
    const verifiedRemoteTransactions = filterSignedTransactions(remoteState.transactions || [], merged.wallets)
      .filter((transaction) => !hasReplayConflict(merged.transactions, transaction));
    merged.peers = sortUnique([...(merged.peers || []), ...(remoteState.peers || [])]);
    merged.transactions = mergeById(merged.transactions, verifiedRemoteTransactions, 'id')
      .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));

    for (const wallet of merged.wallets) {
      ensureWalletNonce(merged, wallet);
    }

    if (remoteState.economics?.updatedAt) {
      const localUpdatedAt = new Date(merged.economics?.updatedAt || 0).getTime();
      const remoteUpdatedAt = new Date(remoteState.economics.updatedAt).getTime();
      if (remoteUpdatedAt >= localUpdatedAt) {
        merged.economics = remoteState.economics;
      }
    }

    return merged;
  }

  async function registerPeer({ url, integrityHash }) {
    const peerUrl = normalizePeerUrl(url);
    if (!peerUrl) {
      throw new Error('Debes ingresar una URL de peer.');
    }

    const state = await readState();
    const checkedAt = new Date().toISOString();

    try {
      const probe = await probePeerUrl(peerUrl);
      if (probe.kind === 'self-hosted') {
        if (integrityHash && probe.integrityHash && integrityHash !== probe.integrityHash) {
          throw new Error('Integrity hash mismatch while linking the peer.');
        }

        const signerTrust = recordTrustedPeerSigner(state, {
          url: peerUrl,
          signerPublicKey: probe.signerPublicKey || null,
          checkedAt,
        });
        state.peerRegistry = upsertPeerRegistryEntry(state.peerRegistry, {
          url: peerUrl,
          role: probe.role,
          signerPublicKey: signerTrust.entry?.signerPublicKey || probe.signerPublicKey || null,
          linkStatus: 'linked',
          syncStatus: signerTrust.rotationDetected ? 'rotation-pending' : 'protocol-verified',
          syncCapable: true,
          lastCheckedAt: checkedAt,
          lastValidatedAt: checkedAt,
          lastSyncedAt: null,
          lastBlockHash: probe.lastBlockHash,
          note: signerTrust.rotationDetected
            ? 'Signer rotation detected during link. The previously pinned signer remains active until an explicit review approves the new key.'
            : 'Peer verified by signed export, consensus finality evidence, and integrity checks.',
        });
        recordChainObservation(state, {
          url: peerUrl,
          signerPublicKey: probe.signerPublicKey || null,
          headHash: probe.lastBlockHash,
          observedAt: checkedAt,
          source: 'probe',
        });

        if (signerTrust.revoked) {
          state.peerRegistry = upsertPeerRegistryEntry(state.peerRegistry, {
            url: peerUrl,
            role: probe.role,
            signerPublicKey: probe.signerPublicKey || null,
            linkStatus: 'revoked',
            syncStatus: 'revoked',
            syncCapable: false,
            lastCheckedAt: checkedAt,
            note: 'The peer is explicitly revoked and must be re-approved by an operator before sync can resume.',
          });
          await writeState(state);
          return {
            state: await getPublicNodeState(),
            peerConnection: state.peerRegistry.find((entry) => entry.url === peerUrl) || null,
            message: 'El peer está revocado y no puede volver a sincronizarse automáticamente.',
          };
        }

        if (signerTrust.rotationDetected) {
          await writeState(state);
          return {
            state: await getPublicNodeState(),
            peerConnection: state.peerRegistry.find((entry) => entry.url === peerUrl) || null,
            message: 'El peer respondió, pero su signer rotó. Se mantiene el signer previo en trust-store y la nueva clave queda pendiente.',
          };
        }

        const mergedState = mergeRemoteState(state, probe.remoteState);
        mergedState.peers = sortUnique([...(mergedState.peers || []), peerUrl]);
        mergedState.peerRegistry = upsertPeerRegistryEntry(mergedState.peerRegistry, {
          url: peerUrl,
          role: probe.role,
          signerPublicKey: probe.signerPublicKey || null,
          linkStatus: 'linked',
          syncStatus: 'synchronized',
          syncCapable: true,
          lastCheckedAt: checkedAt,
          lastValidatedAt: checkedAt,
          lastSyncedAt: checkedAt,
          lastBlockHash: probe.lastBlockHash,
          note: `${probe.note} Chain adoption requires extension validity plus trusted-head quorum.`,
        });
        await writeState(mergedState);
        await announceNodePresence(mergedState);
        return {
          state: await getPublicNodeState(),
          peerConnection: mergedState.peerRegistry.find((entry) => entry.url === peerUrl) || null,
          message: 'Peer linkeado y sincronizado correctamente.',
        };
      }

      if (probe.kind === 'read-only') {
        if (integrityHash && probe.integrityHash && integrityHash !== probe.integrityHash) {
          throw new Error('Integrity hash mismatch while linking the node0 reference.');
        }

        state.peerRegistry = upsertPeerRegistryEntry(state.peerRegistry, {
          url: peerUrl,
          role: probe.role,
          signerPublicKey: probe.signerPublicKey || null,
          linkStatus: 'linked',
          syncStatus: 'read-only',
          syncCapable: false,
          lastCheckedAt: checkedAt,
          lastValidatedAt: checkedAt,
          lastSyncedAt: null,
          lastBlockHash: probe.lastBlockHash,
          note: probe.note,
        });
        await writeState(state);
        await announceNodePresence(state, { includeNode0Url: peerUrl });
        return {
          state: await getPublicNodeState(),
          peerConnection: state.peerRegistry.find((entry) => entry.url === peerUrl) || null,
          message: 'La URL quedó linkeada, pero es un node0/read-only público (por ejemplo Vercel), así que no puede sincronizar como peer self-hosted.',
        };
      }

      state.peerRegistry = upsertPeerRegistryEntry(state.peerRegistry, {
        url: peerUrl,
        role: probe.role,
        signerPublicKey: probe.signerPublicKey || null,
        linkStatus: 'unsupported',
        syncStatus: 'unsupported',
        syncCapable: false,
        lastCheckedAt: checkedAt,
        lastBlockHash: probe.lastBlockHash,
        note: probe.note,
      });
      await writeState(state);
      return {
        state: await getPublicNodeState(),
        peerConnection: state.peerRegistry.find((entry) => entry.url === peerUrl) || null,
        message: 'La URL respondió, pero no expone una API compatible para link o sync.',
      };
    } catch (error) {
      state.peerRegistry = upsertPeerRegistryEntry(state.peerRegistry, {
        url: peerUrl,
        role: 'unknown',
        signerPublicKey: null,
        linkStatus: 'unreachable',
        syncStatus: 'pending',
        syncCapable: false,
        lastCheckedAt: checkedAt,
        lastBlockHash: null,
        note: error.message || 'The peer could not be reached.',
      });
      await writeState(state);
      return {
        state: await getPublicNodeState(),
        peerConnection: state.peerRegistry.find((entry) => entry.url === peerUrl) || null,
        message: 'La URL se guardó, pero ahora mismo no está alcanzable para verificar link/sync.',
      };
    }
  }

  async function reviewPeerSignerRotation({ url, reviewerAddress, reviewerSecret, approve }) {
    const peerUrl = normalizePeerUrl(url);
    if (!peerUrl) {
      throw new Error('Debes indicar la URL del peer.');
    }

    const state = await readState();
    const reviewer = ctx.getWalletByAddress(state, reviewerAddress);
    ctx.assertWalletSecret(reviewer, reviewerSecret);
    if (!ctx.canParticipateAsValidator(state, reviewer)) {
      throw new Error('Solo un validador elegible puede revisar una rotación de signer.');
    }

    const entry = getTrustedPeerSignerEntry(state, peerUrl);
    if (!entry?.pendingSignerPublicKey) {
      throw new Error('Ese peer no tiene una rotación pendiente.');
    }

    if (approve) {
      state.trustedPeerSigners = ctx.upsertTrustedPeerSigner(state.trustedPeerSigners, {
        ...entry,
        signerPublicKey: entry.pendingSignerPublicKey,
        signerHistory: [...(entry.signerHistory || []), entry.pendingSignerPublicKey],
        pendingSignerPublicKey: null,
        trustStatus: 'trusted',
        lastValidatedAt: new Date().toISOString(),
      });
      state.peerRegistry = upsertPeerRegistryEntry(state.peerRegistry, {
        url: peerUrl,
        signerPublicKey: entry.pendingSignerPublicKey,
        syncStatus: 'synchronized',
        note: `Signer rotation approved by ${reviewer.username}.`,
        lastCheckedAt: new Date().toISOString(),
      });
    } else {
      state.trustedPeerSigners = ctx.upsertTrustedPeerSigner(state.trustedPeerSigners, {
        ...entry,
        pendingSignerPublicKey: null,
        trustStatus: 'trusted',
        lastValidatedAt: new Date().toISOString(),
      });
      state.peerRegistry = upsertPeerRegistryEntry(state.peerRegistry, {
        url: peerUrl,
        signerPublicKey: entry.signerPublicKey,
        syncStatus: 'synchronized',
        note: `Signer rotation rejected by ${reviewer.username}; the previous signer remains pinned.`,
        lastCheckedAt: new Date().toISOString(),
      });
    }

    recordAdminAction(state, {
      action: approve ? 'peer_rotation_approved' : 'peer_rotation_rejected',
      actorAddress: reviewer.address,
      actorUsername: reviewer.username,
      targetType: 'peer',
      targetId: peerUrl,
      reason: approve
        ? `Signer rotation approved by ${reviewer.username}.`
        : `Signer rotation rejected by ${reviewer.username}.`,
      status: 'accepted',
      metadata: {
        signerPublicKey: approve ? entry.pendingSignerPublicKey : entry.signerPublicKey,
        pendingSignerPublicKey: entry.pendingSignerPublicKey || null,
      },
    });

    await ctx.commitState(state);
    return {
      peerConnection: state.peerRegistry.find((peer) => peer.url === peerUrl) || null,
      trustedSigner: getTrustedPeerSignerEntry(state, peerUrl),
      state: await getPublicNodeState(),
    };
  }

  async function revokePeerTrust({ url, reviewerAddress, reviewerSecret, reason }) {
    const peerUrl = normalizePeerUrl(url);
    if (!peerUrl) {
      throw new Error('Debes indicar la URL del peer.');
    }

    const state = await readState();
    const reviewer = ctx.getWalletByAddress(state, reviewerAddress);
    ctx.assertWalletSecret(reviewer, reviewerSecret);
    if (!ctx.canParticipateAsValidator(state, reviewer)) {
      throw new Error('Solo un validador elegible puede revocar un peer.');
    }

    const revoked = revokeTrustedPeer(state, {
      url: peerUrl,
      reason: reason || `Peer revoked by ${reviewer.username}.`,
      revokedAt: new Date().toISOString(),
    });

    recordAdminAction(state, {
      action: 'peer_revoked',
      actorAddress: reviewer.address,
      actorUsername: reviewer.username,
      targetType: 'peer',
      targetId: peerUrl,
      reason: reason || `Peer revoked by ${reviewer.username}.`,
      status: 'accepted',
      metadata: {
        revokedSignerPublicKeys: revoked.trustedSigner?.revokedSignerPublicKeys || [],
      },
    });

    await ctx.commitState(state);
    return {
      peerConnection: revoked.peerConnection,
      trustedSigner: revoked.trustedSigner,
      state: await getPublicNodeState(),
    };
  }

  async function ingestRemoteState({ state: remoteState }) {
    if (!remoteState) {
      throw new Error('Debes enviar un state remoto.');
    }
    if (!validateConsensusStateView(remoteState)) {
      throw new Error('El state remoto no trae bloques con finality verificable.');
    }

    const localState = await readState();
    const remoteUrl = normalizePeerUrl(remoteState?.network?.publicUrl);
    const remoteSignerPublicKey = remoteState?.network?.nodeSignerPublicKey || null;
    if (remoteUrl && remoteSignerPublicKey) {
      const signerTrust = recordTrustedPeerSigner(localState, {
        url: remoteUrl,
        signerPublicKey: remoteSignerPublicKey,
        checkedAt: new Date().toISOString(),
      });

      localState.peerRegistry = upsertPeerRegistryEntry(localState.peerRegistry, {
        url: remoteUrl,
        role: remoteState.network?.role || 'self-hosted-full-node',
        signerPublicKey: signerTrust.entry?.signerPublicKey || null,
        linkStatus: signerTrust.revoked ? 'revoked' : 'linked',
        syncStatus: signerTrust.revoked ? 'revoked' : (signerTrust.rotationDetected ? 'rotation-pending' : 'synchronized'),
        syncCapable: !signerTrust.revoked,
        lastCheckedAt: new Date().toISOString(),
        lastValidatedAt: new Date().toISOString(),
        lastSyncedAt: signerTrust.rotationDetected || signerTrust.revoked ? null : new Date().toISOString(),
        lastBlockHash: remoteState.chain?.at?.(-1)?.hash || null,
        note: signerTrust.revoked
          ? 'Sync rejected because this peer was explicitly revoked by an operator.'
          : (signerTrust.rotationDetected
            ? 'Signer rotation detected during sync; chain extension is held until the trust store is updated.'
            : 'Trusted signer observed during sync.'),
      });
      if (signerTrust.revoked) {
        await writeState(localState);
        throw new Error('El peer remoto está revocado y no puede sincronizarse.');
      }
    }
    const mergedState = mergeRemoteState(localState, remoteState);
    await writeState(mergedState);
    return getPublicNodeState();
  }

  return {
    broadcastState,
    announceNodePresence,
    probePeerUrl,
    mergeRemoteState,
    registerPeer,
    reviewPeerSignerRotation,
    revokePeerTrust,
    ingestRemoteState,
  };
}
