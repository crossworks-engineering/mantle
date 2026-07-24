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
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { rateLimit } from '@/lib/rate-limit';
import { resolveTeamChatCaller, teamCallerName } from '@/lib/team-chat-gate';
import { enqueueForumTurn } from '@/lib/forum-turn-enqueue';
import { forumDailySpend, FORUM_DAILY_CAP } from '@/lib/forum-gate';
import { resolveStagedAttachments } from '@/lib/forum-attachments';
import { titleForTopic } from '@/lib/forum-title';
import {
  FORUM_TOPIC_SORTS,
  countForumTopics,
  createForumTopic,
  listForumTopics,
  recordTeamAccess,
  type ForumTopicSort,
} from '@mantle/content';

const PAGE_SIZE = 20;

const CreateBody = z.object({
  /** Omitted by the /team landing composer — the title is then a short
   *  summary of the body (summarizer worker, heuristic fallback). */
  title: z.string().trim().min(1).max(200).optional(),
  // trim() so a whitespace-only body 400s here instead of 500ing when
  // createForumTopic rejects the trimmed-empty opening post.
  body: z.string().trim().min(1).max(20_000),
  kind: z.enum(['question', 'review', 'feature', 'bug', 'discussion']).optional(),
  visibility: z.enum(['team', 'private']).optional(),
  /** Wave the agent off. Defaults to true for 'discussion' topics. */
  noReply: z.boolean().optional(),
  /** Staged forum-upload blob ids (POST /api/team/forum/uploads) to attach to
   *  the opening post. Metadata is derived server-side from the blob rows. */
  attachmentIds: z.array(z.string().uuid()).max(5).optional(),
});

export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
  const query = sp.get('q')?.trim() || undefined;
  const sortParam = sp.get('sort');
  const sort: ForumTopicSort = (FORUM_TOPIC_SORTS as readonly string[]).includes(sortParam ?? '')
    ? (sortParam as ForumTopicSort)
    : 'activity';
  const viewer = { kind: 'member', contactId: caller.contactId } as const;

  const [topics, total] = await Promise.all([
    listForumTopics(caller.ownerId, viewer, {
      query,
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countForumTopics(caller.ownerId, viewer, { query }),
  ]);
  return NextResponse.json({ topics, total, page, pageSize: PAGE_SIZE });
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
  const { body, kind, visibility } = parsed.data;
  const wantsReply = !(parsed.data.noReply ?? kind === 'discussion');
  // Composer path: no explicit title → summarize the message into one.
  // titleForTopic never throws and never returns empty (heuristic fallback).
  const title = parsed.data.title ?? (await titleForTopic(ownerId, body));

  const resolved = await resolveStagedAttachments(
    ownerId,
    contactId,
    parsed.data.attachmentIds ?? [],
  );
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  try {
    const { topic, post } = await createForumTopic({
      ownerId,
      title,
      body,
      kind,
      visibility,
      author: { kind: 'member', contactId },
      channel,
      attachments: resolved.attachments,
      bindUploadIds: resolved.bindIds,
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
    // A lost attachment-bind race (a concurrent post consumed the same staged
    // blobs) rolls this whole create back — surface it as a clean 409 the
    // client can act on, not a generic 500.
    if (msg.includes('attachment is missing or already used')) {
      return NextResponse.json(
        { error: 'those attachments were already posted — re-attach and try again' },
        { status: 409 },
      );
    }
    console.error('[team/forum/topics]', msg);
    return NextResponse.json(
      { error: 'something went wrong creating that topic — the brain admin can see the details' },
      { status: 500 },
    );
  }
}
