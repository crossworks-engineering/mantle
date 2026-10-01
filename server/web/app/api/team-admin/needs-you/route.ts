/**
 * GET /api/team-admin/needs-you : what waits for an admin, as counts (the
 * Review queue and open team requests) plus the newest of each by title and
 * author, never content. Every window, tab and device reads this same
 * answer, refetched when the owner live stream sends `needs_you`. Admins
 * only: getOwnerOr401 refuses a member login.
 */
import { NextResponse } from '@/server/http-compat';
import { loadNeedsYou } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await loadNeedsYou(user.id));
}
