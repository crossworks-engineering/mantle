/**
 * POST /api/team-admin/member-items/:id/unshare : a member's team-shared
 * item goes back to private; nothing is deleted, and its author keeps it.
 * Admin only. 404 when it is not shared with the team any more (a private
 * item answers like a missing one).
 */
import { NextResponse } from '@/server/http-compat';
import { adminUnshareMemberItem } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { SubmissionParams, reviewNotFound } from '@/lib/member-review';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  if (!(await adminUnshareMemberItem(params.data.id))) return reviewNotFound();
  return NextResponse.json({ ok: true });
}
