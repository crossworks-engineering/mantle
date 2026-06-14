// GET/PUT /api/push/preferences — per-trigger toggles + quiet hours (owner-gated).
// PUT accepts a partial patch; unknown/invalid fields are ignored.

import { type NextRequest, NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getPushPrefs, updatePushPrefs, type PushPreferences } from '@/lib/push/store';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function sanitize(body: Record<string, unknown>): Partial<PushPreferences> {
  const patch: Partial<PushPreferences> = {};
  if (typeof body['assistantMessages'] === 'boolean') patch.assistantMessages = body['assistantMessages'];
  if (typeof body['approvals'] === 'boolean') patch.approvals = body['approvals'];
  if (typeof body['quietEnabled'] === 'boolean') patch.quietEnabled = body['quietEnabled'];
  if (typeof body['quietStart'] === 'string' && HHMM.test(body['quietStart'])) patch.quietStart = body['quietStart'];
  if (typeof body['quietEnd'] === 'string' && HHMM.test(body['quietEnd'])) patch.quietEnd = body['quietEnd'];
  if (typeof body['timezone'] === 'string' && isValidTimezone(body['timezone'])) patch.timezone = body['timezone'];
  return patch;
}

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
  return NextResponse.json(await updatePushPrefs(sanitize(body)));
}
