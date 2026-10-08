/**
 * GET /api/team-admin/member-apps: the apps members built that an admin may
 * see (access matrix N2): shared with the team or submitted, not yet
 * accepted; never a private draft. Each says whether its author is still an
 * active member (an app whose author is not runs for nobody).
 */
import { NextResponse } from '@/server/http-compat';
import { listSpaceAppsForAdmin } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ apps: await listSpaceAppsForAdmin() });
}
