/**
 * GET /api/team-admin/submissions/:id[?tab=] : one item an admin may review,
 * its SAVED body (a submitted item is frozen; drafts are never shown) and its
 * thread: the review talk, plus the team's comments while it is shared.
 * Anything else, a private item included, is a 404.
 */
import { NextResponse } from '@/server/http-compat';
import { getReviewItem, listReviewComments } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { SubmissionParams, commentsDto, reviewNotFound } from '@/lib/member-review';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const tab = new URL(req.url).searchParams.get('tab') ?? undefined;
  const item = await getReviewItem(params.data.id, { tabId: tab });
  if (!item) return reviewNotFound();
  const comments = (await listReviewComments(params.data.id)) ?? [];
  return NextResponse.json({ ...item, comments: commentsDto(comments, user) });
}
