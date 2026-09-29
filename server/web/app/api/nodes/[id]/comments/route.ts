/**
 * Owner-side comment thread on a node (tasks first — the model is
 * node-generic, see node-comments.ts).
 *
 *   GET  /api/nodes/[id]/comments[?before=ISO] → { comments: NodeComment[], hasMore }
 *        the newest 100, oldest first; `before` = the oldest shown's createdAt
 *   POST /api/nodes/[id]/comments   { body } → 201 { comment }
 *
 * Attribution is stamped from the SESSION actor (the co-admin login actually
 * acting), never from the request body — the same provenance rule as
 * team_request_create. `mine` is computed here per viewer, so two logins
 * looking at one thread each see their own comments flagged.
 *
 * On an item at CLIENT level, a comment written here joins the client thread
 * (thread_scope 'client', decided in the insert): the team and every client
 * login read it, under the admin's display name (else the email's local
 * part). The owner's GET lists every scope.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { isUuid } from '@/lib/task-schemas';
import {
  COMMENT_BODY_MAX,
  addNodeComment,
  listNodeComments,
  toNodeCommentDto,
} from '@mantle/content';
import { commentPageQuery } from '@/lib/comment-page';
import { firstIssue } from '@/lib/zod-issue';

const PostBody = z.object({
  body: z.string().min(1).max(COMMENT_BODY_MAX),
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const page = commentPageQuery(req);
  if (page instanceof Response) return page;
  const thread = await listNodeComments(user.id, id, page);
  const viewer = { loginId: user.actor.id };
  return NextResponse.json({
    comments: thread.rows.map((r) => toNodeCommentDto(r, viewer)),
    hasMore: thread.hasMore,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const raw = await req.json().catch(() => ({}));
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await addNodeComment(
    user.id,
    id,
    {
      kind: 'owner',
      loginId: user.actor.id,
      name: user.actor.displayName || user.actor.email,
      // On an item at client level the comment joins the client thread
      // (client logins C5): every client login reads the name, so never the
      // full email there.
      clientName: user.actor.displayName?.trim() || user.actor.email.split('@')[0] || 'Admin',
    },
    parsed.data.body,
  );
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(
    { comment: toNodeCommentDto(row, { loginId: user.actor.id }) },
    { status: 201 },
  );
}
