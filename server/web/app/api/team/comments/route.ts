/**
 * Team-member comment surface.
 *
 *   GET  /api/team/comments?nodeId=…  → { comments: NodeComment[] }
 *   POST /api/team/comments           { nodeId, body } → 201 { comment }
 *
 * Same trust model as the rest of /api/team: self-authenticated via
 * resolveTeamChatCaller (membership liveness re-checked per call), and the
 * node must be TEAM-VISIBLE (an active share — the same rule as every /team
 * listing), so a token holder can never write into arbitrary node ids.
 * Attribution comes from the authenticated contact, never from the body.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  COMMENT_BODY_MAX,
  addNodeComment,
  isNodeTeamVisible,
  listNodeComments,
  toNodeCommentDto,
} from '@mantle/content';
import { resolveTeamChatCaller, teamCallerName } from '@/lib/team-chat-gate';

const PostBody = z.object({
  nodeId: z.string().uuid(),
  body: z.string().min(1).max(COMMENT_BODY_MAX),
});

export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const nodeId = new URL(req.url).searchParams.get('nodeId') ?? '';
  if (!nodeId) return NextResponse.json({ error: 'nodeId required' }, { status: 400 });
  if (!(await isNodeTeamVisible(caller.ownerId, nodeId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const rows = await listNodeComments(caller.ownerId, nodeId);
  const viewer = { contactId: caller.contactId };
  return NextResponse.json({ comments: rows.map((r) => toNodeCommentDto(r, viewer)) });
}

export async function POST(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const raw = await req.json().catch(() => ({}));
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const { nodeId, body } = parsed.data;
  if (!(await isNodeTeamVisible(caller.ownerId, nodeId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const name = (await teamCallerName(caller.ownerId, caller.contactId)) ?? 'Team member';
  const row = await addNodeComment(
    caller.ownerId,
    nodeId,
    { kind: 'member', contactId: caller.contactId, name },
    body,
  );
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(
    { comment: toNodeCommentDto(row, { contactId: caller.contactId }) },
    { status: 201 },
  );
}
