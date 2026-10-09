/**
 * GET /api/team-admin/submissions/:id[?tab=] : one item an admin may review,
 * and its SAVED body (a submitted item is frozen; drafts are never shown).
 * Anything else, a private item included, is a 404. No comment thread: the
 * brain has no comments any more (2026-10-09; user-to-user talk moves to the
 * forum). `comments` stays, always empty, so an older UI still renders.
 */
import { NextResponse } from '@/server/http-compat';
import { getReviewItem } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { SubmissionParams, reviewNotFound } from '@/lib/member-review';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const tab = new URL(req.url).searchParams.get('tab') ?? undefined;
  const item = await getReviewItem(params.data.id, { tabId: tab });
  if (!item) return reviewNotFound();
  return NextResponse.json({ ...item, comments: [] });
}
