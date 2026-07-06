/**
 * Owner-only backing API for the Team admin surface's settings. PATCH flips the
 * `teamPrivateReads` switch (whether the Team Chat responder may read the
 * owner's email + journal on a member's behalf). Session-gated — under
 * `/api/team-admin`, which is NOT in PUBLIC_PATHS (only `/api/team` is), so it
 * carries the owner session, never a team token.
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { updateProfilePreferences } from '@mantle/content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const teamPrivateReads = (body as { teamPrivateReads?: unknown }).teamPrivateReads;
  if (typeof teamPrivateReads !== 'boolean') {
    return NextResponse.json({ error: 'teamPrivateReads must be a boolean' }, { status: 400 });
  }
  await updateProfilePreferences(user.id, { teamPrivateReads });
  return NextResponse.json({ teamPrivateReads });
}
