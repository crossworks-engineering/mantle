/**
 * POST /api/team-admin/submissions/:id/return { note } : send a submitted
 * item back to its author with a note (shown as a banner; the author edits
 * and submits again). 404 when it is not waiting any more.
 *
 * On a taken item whose admin is gone (audit F07: offered in the queue
 * again) this is a give-back: it and what was taken with it move back to
 * the author's space, and the give-back's refusals apply (409
 * `author-inactive`, `embed` with the `ids`).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { SpaceItemStateError, returnReviewItem } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import {
  SubmissionParams,
  reviewErrorResponse,
  reviewNotFound,
  reviewer,
} from '@/lib/member-review';
import { spaceStateResponse } from '@/lib/member-space';

const Body = z.object({ note: z.string().max(4000) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'Add a note.' }, { status: 400 });
  try {
    await returnReviewItem(params.data.id, reviewer(user), body.data.note, user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SpaceItemStateError) return spaceStateResponse(err);
    return reviewErrorResponse(err);
  }
}
