/**
 * POST /api/team-admin/submissions/:id/return : send a submitted item back
 * to its author (the author edits and submits again). No note: review flows
 * carry no messages (2026-10-09); a `note` an older client still sends is
 * ignored. 404 when it is not waiting any more.
 *
 * On a taken item whose admin is gone (audit F07: offered in the queue
 * again) this is a give-back: it and what was taken with it move back to
 * the author's space, and the give-back's refusals apply (409
 * `author-inactive`, `embed` with the `ids`).
 */
import { NextResponse } from '@/server/http-compat';
import { SpaceItemStateError, returnReviewItem } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import {
  SubmissionParams,
  reviewErrorResponse,
  reviewNotFound,
  reviewer,
} from '@/lib/member-review';
import { spaceStateResponse } from '@/lib/member-space';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  try {
    await returnReviewItem(params.data.id, reviewer(user), user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SpaceItemStateError) return spaceStateResponse(err);
    return reviewErrorResponse(err);
  }
}
