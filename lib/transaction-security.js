import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBuffer, verify as verifyBuffer } from 'crypto';

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function exportKey(keyObject, options) {
  return keyObject.export(options).toString('base64');
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

export function createWalletKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: exportKey(publicKey, { format: 'der', type: 'spki' }),
    privateKey: exportKey(privateKey, { format: 'der', type: 'pkcs8' }),
  };
}

export function getPublicKeyFromPrivateKey(privateKey) {
  const keyObject = importPrivateKey(privateKey);
  return exportKey(createPublicKey(keyObject), { format: 'der', type: 'spki' });
}

export function canonicalizeTransactionPayload(transaction) {
  return {
    id: transaction.id,
    nonce: transaction.nonce,
    senderAddress: transaction.senderAddress,
    receiverAddress: transaction.receiverAddress,
    amount: transaction.amount,
    feeAmount: transaction.feeAmount,
    totalDebited: transaction.totalDebited,
    timestamp: transaction.timestamp,
    state: transaction.state,
    type: transaction.type,
    summary: transaction.summary,
    metadata: transaction.metadata || null,
  };
}

export function signTransactionPayload(transaction, privateKey) {
  return signBuffer(null, Buffer.from(stableStringify(canonicalizeTransactionPayload(transaction))), importPrivateKey(privateKey)).toString('base64');
}

export function verifyTransactionSignature(transaction, publicKey) {
  if (!transaction?.signature || !publicKey) {
    return false;
  }

  try {
    return verifyBuffer(
      null,
      Buffer.from(stableStringify(canonicalizeTransactionPayload(transaction))),
      importPublicKey(publicKey),
      Buffer.from(transaction.signature, 'base64')
    );
  } catch {
    return false;
  }
}
