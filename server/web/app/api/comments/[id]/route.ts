/**
 * Owner-side single-comment operations.
 *
 *   PATCH  /api/comments/[id]  { body } → { comment }   (author only)
 *   DELETE /api/comments/[id]           → { ok: true }  (any admin login)
 *
 * Edit is authorship-bound: a login may edit only its OWN comments — the
 * words carry a name. Delete is moderation and every login is a full admin
 * (the 0111 model), so any login may delete any comment.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { isUuid } from '@/lib/task-schemas';
import {
  COMMENT_BODY_MAX,
  deleteNodeComment,
  getNodeComment,
  toNodeCommentDto,
  updateNodeComment,
} from '@mantle/content';
import { firstIssue } from '@/lib/zod-issue';

const PatchBody = z.object({
  body: z.string().min(1).max(COMMENT_BODY_MAX),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const existing = await getNodeComment(user.id, id);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (existing.authorKind !== 'owner' || existing.loginId !== user.actor.id) {
    return NextResponse.json({ error: 'only the author can edit a comment' }, { status: 403 });
  }
  const row = await updateNodeComment(user.id, id, parsed.data.body);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ comment: toNodeCommentDto(row, { loginId: user.actor.id }) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const ok = await deleteNodeComment(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
