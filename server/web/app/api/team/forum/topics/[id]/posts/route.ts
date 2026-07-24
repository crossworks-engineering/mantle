/**
 * POST /api/team/forum/topics/[id]/posts — a member's reply in a topic.
 * Unless the post waves the agent off (`noReply`, defaulted ON in `discussion`
 * topics by the client), the durable forum turn is enqueued and the agent
 * answers into the same topic. Members cannot post into closed topics; the
 * owner and the agent still can (their paths don't come through here).
 * Cost guards are the shared team-surface budget — see lib/forum-gate.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { rateLimit } from '@/lib/rate-limit';
import { resolveTeamChatCaller, teamCallerName } from '@/lib/team-chat-gate';
import { enqueueForumTurn } from '@/lib/forum-turn-enqueue';
import { forumDailySpend, FORUM_DAILY_CAP } from '@/lib/forum-gate';
import { resolveStagedAttachments } from '@/lib/forum-attachments';
import { appendForumPost, getForumTopic, recordTeamAccess } from '@mantle/content';

const IdParams = z.object({ id: z.string().uuid() });
const Body = z.object({
  text: z.string().min(1).max(20_000),
  /** Wave the agent off (member-to-member discussion). */
  noReply: z.boolean().optional(),
  /** Staged forum-upload blob ids (POST /api/team/forum/uploads) to attach.
   *  Metadata is derived server-side from the blob rows. */
  attachmentIds: z.array(z.string().uuid()).max(5).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { ownerId, contactId, channel } = caller;

  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid topic id' }, { status: 400 });
  const topicId = idParsed.data.id;

  const gate = rateLimit(`forum-post:${contactId}`, { max: 6, windowMs: 60_000 });
  if (!gate.ok) {
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'rate_limit', surface: 'forum', topicId },
    });
    return NextResponse.json(
      { error: 'too many posts — give it a moment' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
    );
  }
  if ((await forumDailySpend(ownerId, contactId)) >= FORUM_DAILY_CAP) {
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'daily_cap', cap: FORUM_DAILY_CAP, surface: 'forum', topicId },
    });
    return NextResponse.json(
      { error: `daily limit reached (${FORUM_DAILY_CAP}/day) — try again tomorrow` },
      { status: 429 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }

  // Visibility-enforced load; members cannot post into a closed topic.
  const topic = await getForumTopic(ownerId, topicId, { kind: 'member', contactId });
  if (!topic) return NextResponse.json({ error: 'topic not found' }, { status: 404 });
  if (topic.status === 'closed') {
    return NextResponse.json({ error: 'this topic is closed' }, { status: 403 });
  }

  const wantsReply = !(parsed.data.noReply ?? topic.kind === 'discussion');

  const resolved = await resolveStagedAttachments(
    ownerId,
    contactId,
    parsed.data.attachmentIds ?? [],
  );
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  try {
    const post = await appendForumPost({
      ownerId,
      topicId,
      author: { kind: 'member', contactId },
      body: parsed.data.text,
      channel,
      attachments: resolved.attachments,
      bindUploadIds: resolved.bindIds,
    });

    recordTeamAccess({
      ownerId,
      contactId,
      kind: channel === 'api' ? 'api' : 'turn',
      detail: { surface: 'forum', action: 'post', topicId, reply: wantsReply },
    });

    if (!wantsReply) return NextResponse.json({ postId: post.id }, { status: 201 });

    const contactName = await teamCallerName(ownerId, contactId);
    const enq = await enqueueForumTurn({
      ownerId,
      contactId,
      contactName,
      topicId,
      inboundPostId: post.id,
      channel,
      idempotencyKey: req.headers.get('idempotency-key') ?? undefined,
    });
    if (enq.streaming) {
      return NextResponse.json({ postId: post.id, turnId: enq.turnId }, { status: 202 });
    }
    return NextResponse.json({ postId: post.id, outbound: enq.result.outbound }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('attachment is missing or already used')) {
      return NextResponse.json(
        { error: 'those attachments were already posted — re-attach and try again' },
        { status: 409 },
      );
    }
    console.error('[team/forum/posts]', msg);
    return NextResponse.json(
      { error: 'something went wrong posting that — the brain admin can see the details' },
      { status: 500 },
    );
  }
}
