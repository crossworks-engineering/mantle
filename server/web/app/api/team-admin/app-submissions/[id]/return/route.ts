/**
 * POST /api/team-admin/app-submissions/:id/return { note }: send a submitted
 * member app back to its author with a note (team apps Phase 3). The author
 * may change it and submit again.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { returnSpaceApp } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { reviewer } from '@/lib/member-review';
import { spaceAppErrorResponse, spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

const Body = z.object({ note: z.string().max(2000).optional().default('') });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ ok: false, error: 'note is too long' }, { status: 400 });
  }
  try {
    await returnSpaceApp(id, reviewer(user), body.data.note);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
}
