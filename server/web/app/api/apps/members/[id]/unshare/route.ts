/**
 * POST /api/apps/members/:id/unshare: an admin stops a member's team-shared
 * app (access matrix N2). It goes back to private, its author's alone;
 * nothing is deleted. 404 for an app an admin may not reach, 409 when it was
 * not shared.
 */
import { NextResponse } from '@/server/http-compat';
import { adminSpaceApp, adminUnshareSpaceApp } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = spaceAppId((await ctx.params).id);
  if (!id || !(await adminSpaceApp(id))) return spaceAppNotFound();
  if (!(await adminUnshareSpaceApp(id))) {
    return NextResponse.json(
      { ok: false, error: 'This app is not shared with the team.' },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
