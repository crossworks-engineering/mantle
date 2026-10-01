/**
 * POST /api/admin/space/:id/give-back { note }
 * Give an item the calling admin TOOK OVER back to the member who wrote it
 * (audit F07): it and everything taken with it move back to the member's
 * space, the item `returned` with the note (the member's Return banner), the
 * rest as drafts. Answer `GiveBackResult` { id, returned }. No LLM work.
 * 404 for anything that is not a taken item in the caller's own space; 400
 * without a note; 409 `author-inactive` (the member is deactivated, deleted
 * or no longer a member: accept or delete it instead), `unsaved-draft` with
 * the `ids` (save a version first), `embed` with the `ids` the member may not
 * use (brain items above team level, the admin's own items: remove them).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { giveBackTakenItem } from '@mantle/content';
import { getAdminSpaceOr401 } from '@/lib/admin-space';
import { SpaceIdParams, notFound, spaceStateResponse } from '@/lib/member-space';
import { readJsonNoNul } from '@/lib/strip-nul';

const Body = z.object({ note: z.string().max(4000) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return notFound();
  const body = Body.safeParse(await readJsonNoNul(req));
  if (!body.success) return NextResponse.json({ error: 'Add a note.' }, { status: 400 });
  try {
    const res = await giveBackTakenItem(
      caller.brainId,
      { spaceId: caller.spaceId, loginId: caller.loginId },
      params.data.id,
      body.data.note,
    );
    return NextResponse.json(res);
  } catch (err) {
    return spaceStateResponse(err);
  }
}
