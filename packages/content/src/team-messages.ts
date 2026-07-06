/**
 * Team Chat conversation store. One forever-thread per (owner, contact) —
 * the external mirror of the per-agent `assistant_messages` model. Writers are
 * the team turn pipeline (inbound member text, outbound responder reply);
 * readers are the member's own thread view, the admin preview, and the
 * owner-side `team_chat_*` tools that make team activity queryable by the
 * brain.
 */
import { and, count, desc, eq, gte, lt, sql as dsql } from 'drizzle-orm';
import {
  db,
  teamMessages,
  contactTeamTokens,
  nodes,
  type ConversationAttachment,
  type TeamChannel,
  type TeamMessage,
} from '@mantle/db';

export type AppendTeamMessageInput = {
  ownerId: string;
  contactId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  agentId?: string | null;
  model?: string | null;
  channel?: TeamChannel;
  attachments?: ConversationAttachment[];
  traceId?: string | null;
  error?: string | null;
  /** 'pending' inserts the durable "thinking…" bubble the turn pipeline
   *  finalizes later. Ignored when `error` is set (that's always 'failed'). */
  status?: 'pending' | 'complete';
};

/** Persist one turn row. Not fire-and-forget — the transcript IS the product
 *  here, so failures must surface to the turn pipeline. */
export async function appendTeamMessage(input: AppendTeamMessageInput): Promise<TeamMessage> {
  const [row] = await db
    .insert(teamMessages)
    .values({
      ownerId: input.ownerId,
      contactId: input.contactId,
      direction: input.direction,
      text: input.text,
      agentId: input.agentId ?? null,
      model: input.model ?? null,
      channel: input.channel ?? 'web',
      attachments: input.attachments ?? [],
      traceId: input.traceId ?? null,
      error: input.error ?? null,
      status: input.error ? 'failed' : (input.status ?? 'complete'),
    })
    .returning();
  return row!;
}

/** Finalize a pending outbound row (the durable "thinking…" bubble): fill the
 *  reply + flip status, or mark it failed. Mirrors updateAssistantMessageOutcome.
 *  Returns the updated row, or null if it vanished. */
export async function updateTeamMessageOutcome(args: {
  ownerId: string;
  id: string;
  status: 'complete' | 'failed';
  text?: string;
  model?: string | null;
  traceId?: string | null;
  error?: string | null;
}): Promise<TeamMessage | null> {
  const [row] = await db
    .update(teamMessages)
    .set({
      status: args.status,
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    })
    .where(and(eq(teamMessages.ownerId, args.ownerId), eq(teamMessages.id, args.id)))
    .returning();
  return row ?? null;
}

/**
 * A window of one contact's thread, newest-first from `before` (exclusive),
 * returned in ASCENDING order for rendering. `before` is an ISO timestamp
 * cursor (the createdAt of the oldest message the caller already has).
 */
export async function listTeamThread(
  ownerId: string,
  contactId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<TeamMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = [eq(teamMessages.ownerId, ownerId), eq(teamMessages.contactId, contactId)];
  if (opts.before) {
    const cursor = new Date(opts.before);
    if (!Number.isNaN(cursor.getTime())) conds.push(lt(teamMessages.createdAt, cursor));
  }
  const rows = await db
    .select()
    .from(teamMessages)
    .where(and(...conds))
    .orderBy(desc(teamMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Most recent N turns of a thread in ASCENDING order — the context-loader
 *  shape (mirror of recentAssistantMessages). */
export async function recentTeamMessages(
  ownerId: string,
  contactId: string,
  limit = 30,
): Promise<TeamMessage[]> {
  return listTeamThread(ownerId, contactId, { limit });
}

/** Inbound turns this contact has sent since `since` — the daily-cap gate
 *  (a leaked token must never become a wallet drain). */
export async function countTeamInboundSince(
  ownerId: string,
  contactId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.ownerId, ownerId),
        eq(teamMessages.contactId, contactId),
        eq(teamMessages.direction, 'inbound'),
        gte(teamMessages.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

export type TeamMemberActivity = {
  contactId: string;
  /** Contact node title; '(deleted contact)' can't occur here — membership
   *  rows cascade with the contact. */
  contactName: string;
  memberSince: string;
  tokenLastUsedAt: string | null;
  lastMessageAt: string | null;
  lastMessageText: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  messageCount: number;
};

/**
 * The admin member-index: EVERY current team member (a live
 * contact_team_tokens row is the role), annotated with their thread's last
 * message + size. Members with no thread yet sort last, so a freshly enabled
 * member is still visible in the admin view.
 */
export async function listTeamMemberActivity(ownerId: string): Promise<TeamMemberActivity[]> {
  const rows = await db
    .select({
      contactId: contactTeamTokens.contactId,
      contactName: nodes.title,
      memberSince: contactTeamTokens.createdAt,
      tokenLastUsedAt: contactTeamTokens.lastUsedAt,
      lastMessageAt: dsql<string | null>`last_msg.created_at`,
      lastMessageText: dsql<string | null>`last_msg.text`,
      lastMessageDirection: dsql<string | null>`last_msg.direction`,
      messageCount: dsql<number>`coalesce(msg_counts.n, 0)::int`,
    })
    .from(contactTeamTokens)
    .innerJoin(nodes, eq(nodes.id, contactTeamTokens.contactId))
    .leftJoin(
      dsql`lateral (
        select tm.created_at, tm.text, tm.direction
        from team_messages tm
        where tm.owner_id = ${contactTeamTokens.ownerId}
          and tm.contact_id = ${contactTeamTokens.contactId}
        order by tm.created_at desc
        limit 1
      ) last_msg`,
      dsql`true`,
    )
    .leftJoin(
      dsql`lateral (
        select count(*) as n
        from team_messages tm
        where tm.owner_id = ${contactTeamTokens.ownerId}
          and tm.contact_id = ${contactTeamTokens.contactId}
      ) msg_counts`,
      dsql`true`,
    )
    .where(eq(contactTeamTokens.ownerId, ownerId));

  return rows
    .map((r) => ({
      contactId: r.contactId,
      contactName: r.contactName ?? '(unnamed contact)',
      memberSince: r.memberSince.toISOString(),
      tokenLastUsedAt: r.tokenLastUsedAt ? r.tokenLastUsedAt.toISOString() : null,
      lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
      lastMessageText: r.lastMessageText,
      lastMessageDirection: (r.lastMessageDirection ?? null) as 'inbound' | 'outbound' | null,
      messageCount: r.messageCount,
    }))
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
}
