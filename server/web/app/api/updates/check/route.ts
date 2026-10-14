/**
 * Release check for the sidebar's "Update available" banner. Server-side
 * cached (6h TTL in lib/updates.ts), so the banner polling every sidebar
 * mount never hammers the GitHub API.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller, sessionUserCaller } from '@/lib/auth';
import { checkForUpdate } from '@/lib/updates';

/** The cached release check: open to every Admin user, whatever its areas
 *  (the owner's carve-out, 2026-10-14: its row is the login's own,
 *  route-policy.ts ADMIN_OPEN_ROWS). The gate answers the session user
 *  (getSessionUser: an Admin user, or null; A4 hand batch A). */
export async function GET() {
  const user = sessionUserCaller();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json(await checkForUpdate(false));
}

/** Force-refresh the release check (bypasses the 6h cache) for the
 *  /settings/updates "Check now" button. Needs the settings area (the
 *  owner's decision, 2026-10-14): the gate answers before it. */
export async function POST() {
  ownerCaller();
  return NextResponse.json(await checkForUpdate(true));
}
