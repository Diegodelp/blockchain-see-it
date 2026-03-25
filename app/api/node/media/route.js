import { NextResponse } from 'next/server';

import { assertRateLimit } from '@/app/api/_lib/security';
import { createPendingMedia } from '@/lib/self-hosted-node';
import { getMediaUploadPolicy, isSelfHosted } from '@/lib/runtime-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: 'Disponible solo en modo self-hosted.' }, { status: 403 });
  }

  const uploadPolicy = getMediaUploadPolicy();
  const rateLimitResponse = await assertRateLimit(request, {
    bucket: 'node-media-upload',
    limit: uploadPolicy.uploadRateLimitMaxRequests,
    windowMs: uploadPolicy.uploadRateLimitWindowMs,
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const formData = await request.formData();
    return NextResponse.json(
      await createPendingMedia({
        uploaderAddress: formData.get('uploaderAddress'),
        uploaderSecret: formData.get('uploaderSecret'),
        title: formData.get('title'),
        type: formData.get('type'),
        externalUrl: formData.get('externalUrl'),
        file: formData.get('file'),
      })
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
