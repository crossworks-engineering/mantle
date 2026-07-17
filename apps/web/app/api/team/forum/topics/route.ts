/**
 * The Team Forum topic index — the member surface.
 *
 * GET  — topics visible to the calling member ('team' topics + their own
 *        private ones), pinned first then latest activity, with last-post
 *        previews and the member's unread counts.
 * POST — create a topic (title + opening post). Unless the post waves the
 *        agent off (`noReply`, defaulted ON for `discussion` topics), the
 *        durable forum turn is enqueued and the agent's answer lands as the
 *        second post.
 *
 * Cost guards mirror /api/team/turn: per-contact burst rate + the shared
 *  daily budget (team chat inbound + forum posts count against ONE cap — a
 *  leaked token must never become a wallet drain).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit } from '@/lib/rate-limit';
import { resolveTeamChatCaller, teamCallerName } from '@/lib/team-chat-gate';
import { enqueueForumTurn } from '@/lib/forum-turn-enqueue';
import { forumDailySpend, FORUM_DAILY_CAP } from '@/lib/forum-gate';
import { createForumTopic, listForumTopics, recordTeamAccess } from '@mantle/content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  kind: z.enum(['question', 'review', 'feature', 'bug', 'discussion']).optional(),
  visibility: z.enum(['team', 'private']).optional(),
  /** Wave the agent off. Defaults to true for 'discussion' topics. */
  noReply: z.boolean().optional(),
});

export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const topics = await listForumTopics(caller.ownerId, {
    kind: 'member',
    contactId: caller.contactId,
  });
  return NextResponse.json({ topics });
}

export async function POST(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { ownerId, contactId, channel } = caller;

  const gate = rateLimit(`forum-post:${contactId}`, { max: 6, windowMs: 60_000 });
  if (!gate.ok) {
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'rate_limit', surface: 'forum' },
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
      detail: { reason: 'daily_cap', cap: FORUM_DAILY_CAP, surface: 'forum' },
    });
    return NextResponse.json(
      { error: `daily limit reached (${FORUM_DAILY_CAP}/day) — try again tomorrow` },
      { status: 429 },
    );
  }

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const { title, body, kind, visibility } = parsed.data;
  const wantsReply = !(parsed.data.noReply ?? kind === 'discussion');

  try {
    const { topic, post } = await createForumTopic({
      ownerId,
      title,
      body,
      kind,
      visibility,
      author: { kind: 'member', contactId },
      channel,
    });

    recordTeamAccess({
      ownerId,
      contactId,
      kind: channel === 'api' ? 'api' : 'turn',
      detail: {
        surface: 'forum',
        action: 'topic_create',
        topicId: topic.id,
        kind: topic.kind,
        visibility: topic.visibility,
        reply: wantsReply,
      },
    });

    if (!wantsReply) {
      return NextResponse.json({ topicId: topic.id, postId: post.id }, { status: 201 });
    }

    const contactName = await teamCallerName(ownerId, contactId);
    const enq = await enqueueForumTurn({
      ownerId,
      contactId,
      contactName,
      topicId: topic.id,
      inboundPostId: post.id,
      channel,
      idempotencyKey: req.headers.get('idempotency-key') ?? undefined,
    });
    if (enq.streaming) {
      return NextResponse.json(
        { topicId: topic.id, postId: post.id, turnId: enq.turnId },
        { status: 202 },
      );
    }
    return NextResponse.json(
      { topicId: topic.id, postId: post.id, outbound: enq.result.outbound },
      { status: 201 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[team/forum/topics]', msg);
    return NextResponse.json(
      { error: 'something went wrong creating that topic — the brain admin can see the details' },
      { status: 500 },
    );
  }
}
