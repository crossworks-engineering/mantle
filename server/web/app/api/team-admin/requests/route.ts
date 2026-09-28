/**
 * GET /api/team-admin/requests — the Requests tab: every change request (open
 * + done). The forum upload review queue went with the forum (member logins
 * Phase 6), so the answer is `{ badges, requests }` only.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listTeamRequests } from '@mantle/content';
import { teamAdminBadges } from '@/lib/team-admin-overview';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const [badges, requests] = await Promise.all([
    teamAdminBadges(user.id),
    listTeamRequests(user.id, { status: 'all', limit: 200 }),
  ]);

  return NextResponse.json({ badges, requests });
}
