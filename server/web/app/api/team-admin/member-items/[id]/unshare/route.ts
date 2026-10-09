/**
 * POST /api/team-admin/member-items/:id/unshare : a member's team-shared
 * item goes back to private; nothing is deleted, and its author keeps it.
 * Admin only. Only an active member's item in draft or returned: a
 * submitted one waits for approval, a gone author's stays in the review
 * queue. 404 otherwise (a private item answers like a missing one). Writes a
 * `member_item.unshared` row naming the item and its author.
 */
import { NextResponse } from '@/server/http-compat';
import { adminUnshareMemberItem } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget } from '@/lib/audit';
import { SubmissionParams, reviewNotFound } from '@/lib/member-review';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = SubmissionParams.safeParse(await ctx.params);
  if (!params.success) return reviewNotFound();
  const done = await adminUnshareMemberItem(params.data.id);
  if (!done) return reviewNotFound();
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'member_item.unshared',
    method: 'POST',
    path: '/api/team-admin/member-items/:id/unshare',
    detail: { itemId: done.id, type: done.type, authorLoginId: done.authorLoginId },
  });
  return NextResponse.json({ ok: true });
}
