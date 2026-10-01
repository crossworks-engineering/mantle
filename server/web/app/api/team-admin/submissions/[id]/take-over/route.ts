/**
 * POST /api/team-admin/submissions/:id/take-over (no body)
 * Take a SUBMITTED member item out of the Review queue into the calling
 * admin's OWN private space to work on it (audit F07): the item and the
 * bundle it was submitted with move there with the same ids, as `taken`
 * (the author stays on record). Answer `TakeOverResult` { id, moved }. The
 * admin then edits it through /api/admin/space/:id and accepts it
 * (…/accept) or gives it back (…/give-back). Nothing is indexed or
 * extracted, and nothing here starts LLM work.
 * 404 when it is not waiting any more (recalled, handled, taken by another
 * admin); 409 `not-submitted` for a left-behind item that was never
 * submitted (accept or discard it); 409 `too-large`.
 */
import { NextResponse } from '@/server/http-compat';
import { takeOverReviewItem } from '@mantle/content';
import { getAdminSpaceOr401 } from '@/lib/admin-space';
import { SubmissionParams, reviewErrorResponse, reviewNotFound } from '@/lib/member-review';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  // The admin gate, then the acting login's own space (never the anchor's
  // for another admin).
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  try {
    const res = await takeOverReviewItem(params.data.id, {
      loginId: caller.loginId,
      spaceId: caller.spaceId,
    });
    return NextResponse.json(res);
  } catch (err) {
    return reviewErrorResponse(err);
  }
}
