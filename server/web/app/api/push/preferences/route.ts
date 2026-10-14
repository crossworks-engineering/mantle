// GET/PUT /api/push/preferences — per-trigger toggles (owner-gated). PUT accepts
// a partial patch; unknown/invalid fields are ignored. (Quiet hours removed —
// docs/reminder-delivery-routing.md §C.)

import { type NextRequest, NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { getPushPrefs, updatePushPrefs } from '@/lib/push/store';
import { sanitizePushPrefs } from '@/lib/push/preferences-sanitize';
import { readJson } from '@/lib/read-body';

export async function GET() {
  // Owner only: the gate answered the caller and refused anyone else.
  ownerCaller();
  return NextResponse.json(await getPushPrefs());
}

export async function PUT(req: NextRequest) {
  // Owner only: the gate answered the caller and refused anyone else.
  ownerCaller();
  const body = (await readJson(req, { empty: null })) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object')
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  return NextResponse.json(await updatePushPrefs(sanitizePushPrefs(body)));
}
