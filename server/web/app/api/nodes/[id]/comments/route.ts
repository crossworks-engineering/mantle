/**
 * Owner-side comment thread on a node (tasks first — the model is
 * node-generic, see node-comments.ts).
 *
 *   GET  /api/nodes/[id]/comments   → { comments: NodeComment[] }
 *   POST /api/nodes/[id]/comments   { body } → 201 { comment }
 *
 * Attribution is stamped from the SESSION actor (the co-admin login actually
 * acting), never from the request body — the same provenance rule as
 * team_request_create. `mine` is computed here per viewer, so two logins
 * looking at one thread each see their own comments flagged.
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

const PostBody = z.object({
  body: z.string().min(1).max(COMMENT_BODY_MAX),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const rows = await listNodeComments(user.id, id);
  const viewer = { loginId: user.actor.id };
  return NextResponse.json({ comments: rows.map((r) => toNodeCommentDto(r, viewer)) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const raw = await req.json().catch(() => ({}));
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const row = await addNodeComment(
    user.id,
    id,
    {
      kind: 'owner',
      loginId: user.actor.id,
      name: user.actor.displayName || user.actor.email,
    },
    parsed.data.body,
  );
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(
    { comment: toNodeCommentDto(row, { loginId: user.actor.id }) },
    { status: 201 },
  );
}
