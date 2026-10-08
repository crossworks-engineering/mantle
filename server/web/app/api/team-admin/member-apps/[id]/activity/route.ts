/**
 * GET /api/team-admin/member-apps/:id/activity: what a member's app did
 * (access matrix N3): its runs, tool calls and writes, connector inputs
 * included, newest first. Logged under the author's space while it is a
 * member's app; an admin reads them here by app. Accept moves them to the
 * brain app's own Activity tab.
 */
import { NextResponse } from '@/server/http-compat';
import { asSystem } from '@mantle/db';
import { adminSpaceApp, listAppAccess } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = spaceAppId((await ctx.params).id);
  const app = id ? await adminSpaceApp(id) : null;
  if (!id || !app) return spaceAppNotFound();
  const entries = await asSystem(() => listAppAccess(app.spaceId, id, 200));
  return NextResponse.json({ entries });
}
