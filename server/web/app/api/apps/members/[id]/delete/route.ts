/**
 * POST /api/apps/members/:id/delete { confirm: true }: an admin deletes a
 * member's team-shared or submitted app (access matrix N2). Never silently:
 * the app moves to the brain, its code and data are kept as a pre_delete
 * snapshot, and it waits in the brain's trash like any deleted app, for an
 * admin to restore for 30 days (M4 audit, medium 2). A private draft is
 * never reachable here.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { adminDeleteSpaceApp, adminSpaceApp } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

const Body = z.object({ confirm: z.literal(true) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = spaceAppId((await ctx.params).id);
  const app = id ? await adminSpaceApp(id) : null;
  if (!id || !app) return spaceAppNotFound();
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json(
      { ok: false, error: 'Send { confirm: true } to delete this app.' },
      { status: 400 },
    );
  }
  const ok = await adminDeleteSpaceApp(user.id, id);
  if (!ok) return spaceAppNotFound();
  return NextResponse.json({ ok: true });
}
