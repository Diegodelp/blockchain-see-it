import { NextResponse } from 'next/server';

import { getRequestLogContext, incrementCounter, logEvent } from '@/lib/observability';
import { consumeRateLimit } from '@/lib/rate-limit-store';
import { getAdminOriginAllowlist } from '@/lib/runtime-config';

const DEFAULT_OPERATOR_ROLES = ['viewer', 'operator', 'validator-admin', 'incident-response'];

function normalizeIp(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'local';
}

function readProvidedOperatorToken(request) {
  const bearer = String(request.headers.get('authorization') || '').trim();
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
  const headerToken = String(request.headers.get('x-streamchain-operator-token') || '').trim();
  return token || headerToken || '';
}

function parseRoleList(value) {
  return String(value || '')
    .split('|')
    .map((role) => role.trim())
    .filter(Boolean);
}


function normalizeOrigin(value) {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

function readRequestOrigin(request) {
  return normalizeOrigin(request.headers.get('origin'))
    || normalizeOrigin(request.headers.get('referer'));
}

function isExpiredOperatorEntry(entry, now = Date.now()) {
  return Number.isFinite(entry?.expiresAtMs) ? now > entry.expiresAtMs : false;
}

function parseOperatorEntry(entry) {
  const segments = String(entry || '')
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const credentialSegment = segments[0];
  const delimiterIndex = credentialSegment.includes('=') ? credentialSegment.indexOf('=') : credentialSegment.indexOf(':');
  if (delimiterIndex <= 0) {
    return null;
  }

  const token = credentialSegment.slice(0, delimiterIndex).trim();
  const roles = parseRoleList(credentialSegment.slice(delimiterIndex + 1));
  if (!token || roles.length === 0) {
    return null;
  }

  const metadata = new Map(
    segments.slice(1)
      .map((segment) => {
        const separator = segment.indexOf('=');
        if (separator <= 0) {
          return null;
        }
        return [segment.slice(0, separator).trim(), segment.slice(separator + 1).trim()];
      })
      .filter(Boolean)
  );

  const expiresAt = metadata.get('expires') || null;
  const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : null;
  if (expiresAt && !Number.isFinite(expiresAtMs)) {
    return null;
  }

  return {
    token,
    roles,
    tokenId: metadata.get('id') || null,
    expiresAt,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

function readConfiguredOperatorEntries() {
  const legacyToken = String(process.env.STREAMCHAIN_OPERATOR_TOKEN || '').trim();
  const configuredEntries = String(process.env.STREAMCHAIN_OPERATOR_TOKENS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseOperatorEntry(entry))
    .filter(Boolean);

  if (legacyToken) {
    configuredEntries.unshift({
      token: legacyToken,
      roles: [...DEFAULT_OPERATOR_ROLES],
      tokenId: 'legacy-super-operator',
      expiresAt: null,
      expiresAtMs: null,
    });
  }

  return configuredEntries;
}

export function hasConfiguredOperatorAccess() {
  return readConfiguredOperatorEntries().some((entry) => !isExpiredOperatorEntry(entry));
}

export function getOperatorAccess(request) {
  const entries = readConfiguredOperatorEntries();
  if (entries.length === 0) {
    return { ok: true, configured: false, token: null, tokenId: null, expiresAt: null, roles: new Set() };
  }

  const providedToken = readProvidedOperatorToken(request);
  const match = entries.find((entry) => entry.token === providedToken);
  if (!match) {
    return { ok: false, configured: true, token: providedToken || null, tokenId: null, expiresAt: null, roles: new Set(), expired: false };
  }

  const expired = isExpiredOperatorEntry(match);
  return {
    ok: !expired,
    configured: true,
    token: providedToken,
    tokenId: match.tokenId,
    expiresAt: match.expiresAt,
    expired,
    roles: new Set(match.roles),
  };
}

export function assertOperatorAccess(request, { requiredRoles = [] } = {}) {
  const access = getOperatorAccess(request);
  if (!access.configured) {
    return null;
  }

  if (!access.ok) {
    incrementCounter('streamchain_operator_auth_failures_total', {
      route: request.nextUrl?.pathname || 'unknown',
      reason: access.expired ? 'expired' : 'invalid',
    });
    logEvent('warn', access.expired ? 'operator_auth_expired' : 'operator_auth_failed', getRequestLogContext(request, {
      ip: normalizeIp(request),
      tokenId: access.tokenId,
      expiresAt: access.expiresAt,
    }));
    return NextResponse.json({
      error: access.expired
        ? 'Operator token expirado.'
        : 'Operator token inválido o ausente.',
    }, { status: 401 });
  }

  const allowedOrigins = getAdminOriginAllowlist();
  const requestOrigin = readRequestOrigin(request);
  if (allowedOrigins.length > 0 && requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    incrementCounter('streamchain_operator_origin_denials_total', { route: request.nextUrl?.pathname || 'unknown' });
    logEvent('warn', 'operator_origin_denied', getRequestLogContext(request, {
      ip: normalizeIp(request),
      tokenId: access.tokenId,
      requestOrigin,
      allowedOrigins,
    }));
    return NextResponse.json({ error: 'El origen de administración no está permitido para este endpoint.' }, { status: 403 });
  }

  if (requiredRoles.length > 0 && !requiredRoles.some((role) => access.roles.has(role))) {
    incrementCounter('streamchain_operator_authorization_failures_total', { route: request.nextUrl?.pathname || 'unknown' });
    logEvent('warn', 'operator_authz_failed', getRequestLogContext(request, {
      ip: normalizeIp(request),
      tokenId: access.tokenId,
      requiredRoles,
      grantedRoles: Array.from(access.roles),
    }));
    return NextResponse.json({ error: 'El operador autenticado no tiene permisos para esta acción.' }, { status: 403 });
  }

  return null;
}

export function assertOperatorToken(request) {
  return assertOperatorAccess(request);
}

export async function assertRateLimit(request, {
  bucket,
  limit = 20,
  windowMs = 60_000,
} = {}) {
  const key = `${bucket || 'default'}:${normalizeIp(request)}`;
  const result = await consumeRateLimit(key, { limit, windowMs });

  if (result.allowed) {
    return null;
  }

  incrementCounter('streamchain_rate_limit_denials_total', { bucket: bucket || 'default' });
  logEvent('warn', 'rate_limit_denied', getRequestLogContext(request, {
    bucket: bucket || 'default',
    ip: normalizeIp(request),
    retryAfterMs: result.retryAfterMs,
  }));

  return NextResponse.json({
    error: 'Rate limit excedido para esta operación sensible.',
    retryAfterMs: result.retryAfterMs,
  }, {
    status: 429,
    headers: {
      'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)),
    },
  });
}
