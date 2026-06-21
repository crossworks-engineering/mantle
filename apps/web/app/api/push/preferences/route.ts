// GET/PUT /api/push/preferences — per-trigger toggles + quiet hours (owner-gated).
// PUT accepts a partial patch; unknown/invalid fields are ignored.

import { type NextRequest, NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getPushPrefs, updatePushPrefs } from '@/lib/push/store';
import { sanitizePushPrefs } from '@/lib/push/preferences-sanitize';

export async function GET() {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;
  return NextResponse.json(await getPushPrefs());
}

export async function PUT(req: NextRequest) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  return NextResponse.json(await updatePushPrefs(sanitizePushPrefs(body)));
}
