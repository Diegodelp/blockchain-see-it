import { createHash, createPrivateKey, createPublicKey, sign as signBuffer, verify as verifyBuffer } from 'crypto';

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function getBlockPayload(block, prevHashOverride) {
  const {
    hash,
    signature,
    signerPublicKey,
    quorumCertificate,
    proposalCertificate,
    consensusLifecycle,
    finalityStatus,
    ...payload
  } = block || {};
  return {
    ...payload,
    prevHash: typeof prevHashOverride === 'undefined' ? (payload.prevHash ?? null) : prevHashOverride,
  };
}

function importPrivateKey(privateKey) {
  return createPrivateKey({
    key: Buffer.from(String(privateKey || ''), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

function importPublicKey(publicKey) {
  return createPublicKey({
    key: Buffer.from(String(publicKey || ''), 'base64'),
    format: 'der',
    type: 'spki',
  });
}

export function computeBlockHash(block, prevHashOverride) {
  return createHash('sha256').update(stableStringify(getBlockPayload(block, prevHashOverride))).digest('hex');
}

export function normalizeChain(chain = []) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return [];
  }

  return chain.map((block, index, list) => {
    const prevHash = index === 0 ? null : list[index - 1].hash;
    const payload = getBlockPayload(block, prevHash);
    const hash = computeBlockHash(payload, prevHash);
    const normalizedBlock = {
      ...payload,
      hash,
    };

    if (!block?.signerPublicKey || !block?.signature) {
      return normalizedBlock;
    }

    const signedNormalizedBlock = {
      ...normalizedBlock,
      signerPublicKey: block.signerPublicKey,
      signature: block.signature,
    };

    return verifyBlockSignature(signedNormalizedBlock) ? signedNormalizedBlock : normalizedBlock;
  });
}

export function signBlockPayload(block, privateKey) {
  return signBuffer(null, Buffer.from(stableStringify(getBlockPayload(block))), importPrivateKey(privateKey)).toString('base64');
}

export function signConsensusPayload(payload, privateKey) {
  return signBuffer(null, Buffer.from(stableStringify(payload)), importPrivateKey(privateKey)).toString('base64');
}

export function createConsensusVotePayload(vote = {}) {
  return {
    phase: vote.phase || null,
    blockHash: vote.blockHash || null,
    height: Number.isInteger(vote.height) ? vote.height : Number(vote.height || 0),
    round: Number.isInteger(vote.round) ? vote.round : Number(vote.round || 0),
    epoch: Number.isInteger(vote.epoch) ? vote.epoch : Number(vote.epoch || 0),
    validatorSetHash: vote.validatorSetHash || null,
    validatorAddress: vote.validatorAddress || null,
    validatorPublicKey: vote.validatorPublicKey || null,
  };
}

export function verifyBlockSignature(block) {
  if (!block?.signature || !block?.signerPublicKey) {
    return false;
  }

  try {
    return verifyBuffer(
      null,
      Buffer.from(stableStringify(getBlockPayload(block))),
      importPublicKey(block.signerPublicKey),
      Buffer.from(block.signature, 'base64')
    );
  } catch {
    return false;
  }
}

export function verifyConsensusSignature(payload, publicKey, signature) {
  if (!payload || !publicKey || !signature) {
    return false;
  }

  try {
    return verifyBuffer(
      null,
      Buffer.from(stableStringify(payload)),
      importPublicKey(publicKey),
      Buffer.from(signature, 'base64')
    );
  } catch {
    return false;
  }
}

export function isValidChain(chain, options = {}) {
  const requireSignatures = options.requireSignatures !== false;
  const expectedSignerPublicKey = options.expectedSignerPublicKey || null;

  if (!Array.isArray(chain) || chain.length === 0) {
    return false;
  }

  for (let index = 0; index < chain.length; index += 1) {
    const current = chain[index];
    const previous = chain[index - 1];
    const expectedPrevHash = index === 0 ? null : previous.hash;
    if ((current.prevHash ?? null) !== expectedPrevHash) {
      return false;
    }
    if (current.hash !== computeBlockHash(current, expectedPrevHash)) {
      return false;
    }
    if (requireSignatures && (!current.signature || !current.signerPublicKey)) {
      return false;
    }
    if (expectedSignerPublicKey && current.signerPublicKey !== expectedSignerPublicKey) {
      return false;
    }
    if ((current.signature || current.signerPublicKey) && !verifyBlockSignature(current)) {
      return false;
    }
  }

  return true;
}
