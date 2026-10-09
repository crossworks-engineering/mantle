/**
 * POST /api/admin/space/:id/give-back
 * Give an item the calling admin TOOK OVER back to the member who wrote it
 * (audit F07): it and everything taken with it move back to the member's
 * space, the item `returned` (no note: review flows carry no messages; a
 * `note` an older client sends is ignored), the rest as drafts. Answer `GiveBackResult` { id, returned }. No LLM work.
 * 404 for anything that is not a taken item in the caller's own space; 409 `author-inactive` (the member is deactivated, deleted
 * or no longer a member: accept or delete it instead), `unsaved-draft` with
 * the `ids` (save a version first), `embed` with the `ids` the member may not
 * use (brain items above team level, the admin's own items: remove them).
 */
import { NextResponse } from '@/server/http-compat';
import { giveBackTakenItem } from '@mantle/content';
import { getAdminSpaceOr401 } from '@/lib/admin-space';
import { SpaceIdParams, notFound, spaceStateResponse } from '@/lib/member-space';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return notFound();
  try {
    const res = await giveBackTakenItem(
      caller.brainId,
      { spaceId: caller.spaceId, loginId: caller.loginId },
      params.data.id,
    );
    return NextResponse.json(res);
  } catch (err) {
    return spaceStateResponse(err);
  }
}
