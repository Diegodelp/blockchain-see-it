import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_GENESIS_NODE0_URL = 'https://blockchain-see-it.vercel.app';

const DEFAULT_MEDIA_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MEDIA_ALLOWED_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readOptionalValue(name) {
  const value = String(process.env[name] || '').trim();
  return value || null;
}

function readCommaSeparatedEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function readPositiveInteger(name, fallback) {
  const value = Number.parseInt(String(process.env[name] || ''), 10);
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  return fallback;
}

function readRate(name, fallback) {
  const value = Number(process.env[name]);
  if (Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  return fallback;
}

export function getNodeMode() {
  return process.env.STREAMCHAIN_NODE_MODE === 'self-hosted' ? 'self-hosted' : 'node0';
}

export function isSelfHosted() {
  return getNodeMode() === 'self-hosted';
}

export function getStorageDir() {
  return process.env.STREAMCHAIN_STORAGE_DIR
    ? path.resolve(process.env.STREAMCHAIN_STORAGE_DIR)
    : path.join(PROJECT_ROOT, 'storage');
}

export function getKeyStoreDir() {
  return process.env.STREAMCHAIN_KEYSTORE_DIR
    ? path.resolve(process.env.STREAMCHAIN_KEYSTORE_DIR)
    : getStorageDir();
}

export function getBackupDir() {
  return process.env.STREAMCHAIN_BACKUP_DIR
    ? path.resolve(process.env.STREAMCHAIN_BACKUP_DIR)
    : path.join(PROJECT_ROOT, 'backups');
}

export function getRateLimitDbPath() {
  return process.env.STREAMCHAIN_RATE_LIMIT_DB
    ? path.resolve(process.env.STREAMCHAIN_RATE_LIMIT_DB)
    : path.join(getStorageDir(), 'rate-limit.sqlite');
}

export function getFeeConfig() {
  return {
    transactionFeeRate: readRate('STREAMCHAIN_TX_FEE_RATE', 0.01),
    marketplaceFeeRate: readRate('STREAMCHAIN_MARKETPLACE_FEE_RATE', 0.05),
    creatorRoyaltyRate: readRate('STREAMCHAIN_CREATOR_ROYALTY_RATE', 0.1),
  };
}

export function getNode0RegistrationSecret() {
  return String(process.env.STREAMCHAIN_NODE0_REGISTRATION_SECRET || '').trim();
}

export function getFederationSharedSecret() {
  return String(process.env.STREAMCHAIN_FEDERATION_SHARED_SECRET || '').trim();
}

export function getFederationAllowedPeers() {
  return readCommaSeparatedEnv('STREAMCHAIN_FEDERATION_ALLOWLIST');
}

export function getConfiguredNodeSigner() {
  const privateKey = readOptionalValue('STREAMCHAIN_NODE_SIGNER_PRIVATE_KEY');
  const privateKeyFile = readOptionalValue('STREAMCHAIN_NODE_SIGNER_PRIVATE_KEY_FILE');
  const secretUrl = readOptionalValue('STREAMCHAIN_NODE_SIGNER_SECRET_URL');
  const secretToken = readOptionalValue('STREAMCHAIN_NODE_SIGNER_SECRET_TOKEN');
  const publicKey = readOptionalValue('STREAMCHAIN_NODE_SIGNER_PUBLIC_KEY');
  return {
    privateKey,
    privateKeyFile,
    secretUrl,
    secretToken,
    publicKey,
  };
}

export function getPublicBaseUrl() {
  return String(process.env.STREAMCHAIN_PUBLIC_URL || '').trim().replace(/\/+$/, '');
}

export function getNode0RegistrationTargets() {
  const configured = readCommaSeparatedEnv('STREAMCHAIN_NODE0_REGISTRATION_TARGETS');

  return configured.length > 0 ? configured : [DEFAULT_GENESIS_NODE0_URL];
}

export function getGenesisNode0Url() {
  return String(process.env.STREAMCHAIN_GENESIS_NODE0_URL || DEFAULT_GENESIS_NODE0_URL).trim().replace(/\/+$/, '');
}

export function getPeerSeedUrls() {
  return readCommaSeparatedEnv('STREAMCHAIN_PEER_SEEDS');
}


export function getMediaUploadPolicy() {
  const allowedMimeTypes = readCommaSeparatedEnv('STREAMCHAIN_MEDIA_ALLOWED_MIME_TYPES');
  return {
    maxUploadBytes: readPositiveInteger('STREAMCHAIN_MEDIA_MAX_UPLOAD_BYTES', DEFAULT_MEDIA_UPLOAD_MAX_BYTES),
    allowedMimeTypes: allowedMimeTypes.length > 0 ? allowedMimeTypes.map((item) => item.toLowerCase()) : [...DEFAULT_MEDIA_ALLOWED_MIME_TYPES],
    maxUploadsPerWallet: readPositiveInteger('STREAMCHAIN_MEDIA_MAX_UPLOADS_PER_WALLET', 25),
    uploadRateLimitWindowMs: readPositiveInteger('STREAMCHAIN_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS', 60_000),
    uploadRateLimitMaxRequests: readPositiveInteger('STREAMCHAIN_MEDIA_UPLOAD_RATE_LIMIT_MAX_REQUESTS', 10),
  };
}


export function getAdminOriginAllowlist() {
  return readCommaSeparatedEnv('STREAMCHAIN_ADMIN_ORIGIN_ALLOWLIST');
}

export function getObservabilityConfig() {
  return {
    serviceName: readOptionalValue('STREAMCHAIN_SERVICE_NAME') || 'streamchain',
    metricsEnabled: String(process.env.STREAMCHAIN_METRICS_ENABLED || 'true').toLowerCase() !== 'false',
    structuredLogs: String(process.env.STREAMCHAIN_STRUCTURED_LOGS || 'true').toLowerCase() !== 'false',
  };
}

export function getPublicContactInfo(defaults = {}) {
  return {
    ...defaults,
    headline: readOptionalValue('STREAMCHAIN_CONTACT_HEADLINE') || defaults.headline || 'Habla con el equipo de StreamChain',
    supportEmail: readOptionalValue('STREAMCHAIN_CONTACT_SUPPORT_EMAIL') || defaults.supportEmail || null,
    businessEmail: readOptionalValue('STREAMCHAIN_CONTACT_BUSINESS_EMAIL') || defaults.businessEmail || null,
    docsUrl: readOptionalValue('STREAMCHAIN_CONTACT_DOCS_URL') || defaults.docsUrl || null,
    supportUrl: readOptionalValue('STREAMCHAIN_CONTACT_SUPPORT_URL') || defaults.supportUrl || null,
    partnershipUrl: readOptionalValue('STREAMCHAIN_CONTACT_PARTNERSHIP_URL') || defaults.partnershipUrl || null,
    discordUrl: readOptionalValue('STREAMCHAIN_CONTACT_DISCORD_URL') || defaults.discordUrl || null,
    telegramUrl: readOptionalValue('STREAMCHAIN_CONTACT_TELEGRAM_URL') || defaults.telegramUrl || null,
    calendlyUrl: readOptionalValue('STREAMCHAIN_CONTACT_CALENDLY_URL') || defaults.calendlyUrl || null,
    responseSla: readOptionalValue('STREAMCHAIN_CONTACT_RESPONSE_SLA') || defaults.responseSla || '48h',
    timezone: readOptionalValue('STREAMCHAIN_CONTACT_TIMEZONE') || defaults.timezone || 'UTC',
  };
}
