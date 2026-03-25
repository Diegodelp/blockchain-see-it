import fs from 'fs/promises';
import path from 'path';

import { NextResponse } from 'next/server';

import { getKeyStoreDir, getNodeMode, getRateLimitDbPath, getStorageDir, isSelfHosted } from '@/lib/runtime-config';
import { hasConfiguredOperatorAccess } from '@/app/api/_lib/security';
import { getOperationalHealth } from '@/lib/self-hosted-node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function pathReadable(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const base = {
    ok: true,
    mode: getNodeMode(),
    checkedAt: new Date().toISOString(),
  };

  if (!isSelfHosted()) {
    return NextResponse.json(base);
  }

  const operational = await getOperationalHealth();
  const storageDir = getStorageDir();
  const keyStoreDir = getKeyStoreDir();
  const rateLimitDbPath = getRateLimitDbPath();
  const checks = {
    storageDirReadable: await pathReadable(storageDir),
    keyStoreDirReadable: await pathReadable(keyStoreDir),
    rateLimitDbDirectoryReadable: await pathReadable(path.dirname(rateLimitDbPath)),
    signerConfigured: operational.signerConfigured,
    writesEnabled: operational.writesEnabled,
    operatorTokenConfigured: hasConfiguredOperatorAccess(),
  };

  const ok = Object.values(checks).every(Boolean);
  return NextResponse.json({
    ...base,
    ok,
    operational,
    checks,
  }, { status: ok ? 200 : 503 });
}
