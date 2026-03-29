import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

import { getRateLimitDbPath } from '@/lib/runtime-config';

function getFallbackRateLimitDbPath() {
  return path.join(os.tmpdir(), 'streamchain-node0', 'rate-limit.sqlite');
}

async function ensureDbDir(dbPath) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
}

async function resolveWritableDbPath() {
  const configuredPath = getRateLimitDbPath();
  try {
    await ensureDbDir(configuredPath);
    return configuredPath;
  } catch (error) {
    const fallbackPath = getFallbackRateLimitDbPath();
    if (path.resolve(fallbackPath) === path.resolve(configuredPath)) {
      throw error;
    }

    console.warn('[streamchain:rate-limit] failed to initialize db directory, using tmp fallback', {
      configuredPath,
      fallbackPath,
      code: error?.code || null,
      message: error?.message || null,
    });
    await ensureDbDir(fallbackPath);
    return fallbackPath;
  }
}

function openRateLimitDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS federation_replay_keys (
      key TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
  return { db, dbPath };
}

export async function consumeRateLimit(key, { limit = 20, windowMs = 60_000 } = {}) {
  const dbPath = await resolveWritableDbPath();
  const { db } = openRateLimitDb(dbPath);
  const now = Date.now();
  try {
    const existing = db.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?').get(key);
    const resetAt = existing && now <= Number(existing.reset_at) ? Number(existing.reset_at) : now + windowMs;
    const nextCount = existing && now <= Number(existing.reset_at) ? Number(existing.count) + 1 : 1;
    db.prepare(`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at
    `).run(key, nextCount, resetAt);
    db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').run(now - windowMs);
    return {
      allowed: nextCount <= limit,
      count: nextCount,
      resetAt,
      retryAfterMs: Math.max(0, resetAt - now),
    };
  } finally {
    db.close();
  }
}


export async function rememberFederationReplayKey(key, { ttlMs = 300_000 } = {}) {
  const dbPath = await resolveWritableDbPath();
  const { db } = openRateLimitDb(dbPath);
  const now = Date.now();
  const expiresAt = now + ttlMs;

  try {
    db.prepare('DELETE FROM federation_replay_keys WHERE expires_at < ?').run(now);
    const existing = db.prepare('SELECT key FROM federation_replay_keys WHERE key = ?').get(key);
    if (existing) {
      return { ok: false, replayed: true, expiresAt };
    }

    db.prepare('INSERT INTO federation_replay_keys (key, expires_at) VALUES (?, ?)').run(key, expiresAt);
    return { ok: true, replayed: false, expiresAt };
  } finally {
    db.close();
  }
}
