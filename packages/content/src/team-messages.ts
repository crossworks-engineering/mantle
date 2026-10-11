/**
 * A user's chat thread with a workspace assistant (workspaces W7c, 0269):
 * the store the workspace turn engine (run-team-turn.ts) writes and reads.
 * Since 0269 a member's thread with the Team assistant is an ordinary
 * per-(agent, login) thread in `assistant_messages`, like the owner's: the
 * turn writes its rows there with the login, row security lets only that
 * login read them, and these helpers always name the login.
 *
 * `team_messages` is frozen (0269) and stays until W8. Its team-portal
 * contact rows (no login) are history only, read by the owner's
 * `team_chat_*` tools through `listTeamThread` and `listTeamMemberActivity`.
 * Admin users no longer read other users' chats (the owner's answer of
 * 2026-10-11): nothing here reads a login's thread for anyone but that login.
 */
import { and, desc, eq, gte, isNull, lt, sql as dsql } from 'drizzle-orm';
import {
  assistantMessages,
  db,
  systemDb,
  teamMessages,
  type AssistantMessage,
  type ConversationAttachment,
  type ConversationChannel,
  type TeamMessage,
} from '@mantle/db';
import type { TeamMemberActivity } from '@mantle/client-types';

// The turn engine runs in the workspace's turn scope, whose role reads its
// own login's rows but never writes: the writes use systemDb, each naming
// the login and the agent explicitly.
export type { TeamMemberActivity };

/** A row of a login's thread as the turn engine reads it: the message, plus
 *  the two marks only a workspace turn sets (in `data`). */
export type ThreadMessage = AssistantMessage & {
  /** The turn's trace (data.trace_id), for the deep link from a reply. */
  traceId: string | null;
  /** A reply that may quote the login's PRIVATE items (audit S3). */
  usedPrivate: boolean;
};

function threadMessage(row: AssistantMessage): ThreadMessage {
  const data = (row.data ?? {}) as { trace_id?: unknown; used_private?: unknown };
  return {
    ...row,
    traceId: typeof data.trace_id === 'string' ? data.trace_id : null,
    usedPrivate: data.used_private === true,
  };
}

export type AppendThreadMessageInput = {
  ownerId: string;
  /** The workspace assistant whose thread this is. */
  agentId: string;
  /** The login whose thread this is. */
  loginId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  model?: string | null;
  channel?: ConversationChannel;
  attachments?: ConversationAttachment[];
  error?: string | null;
  /** 'pending' inserts the durable "thinking…" bubble the turn finalizes
   *  later. Ignored when `error` is set (that's always 'failed'). */
  status?: 'pending' | 'complete';
};

/** Persist one turn row of a login's thread. Not fire-and-forget: the
 *  transcript IS the product here, so failures must surface. */
export async function appendThreadMessage(input: AppendThreadMessageInput): Promise<ThreadMessage> {
  const [row] = await systemDb
    .insert(assistantMessages)
    .values({
      ownerId: input.ownerId,
      agentId: input.agentId,
      loginId: input.loginId,
      direction: input.direction,
      text: input.text,
      model: input.model ?? null,
      channel: input.channel ?? 'web',
      attachments: input.attachments ?? [],
      error: input.error ?? null,
      status: input.error ? 'failed' : (input.status ?? 'complete'),
    })
    .returning();
  if (!row) throw new Error('appendThreadMessage: insert returned no row');
  return threadMessage(row);
}

export type UpdateThreadMessageOutcomeInput = {
  ownerId: string;
  /** The login whose row this is: a row of another login is never touched. */
  loginId: string;
  id: string;
  status: 'complete' | 'failed';
  text?: string;
  model?: string | null;
  traceId?: string | null;
  error?: string | null;
  /** Media the turn's tools produced: node references only, never bytes. */
  attachments?: ConversationAttachment[];
  /** The reply may quote the login's private items (audit S3). */
  usedPrivate?: boolean;
};

/** Finalize a pending outbound row (the durable "thinking…" bubble): fill the
 *  reply and flip the status, or mark it failed. Returns the updated row, or
 *  null if it vanished. */
export async function updateThreadMessageOutcome(
  args: UpdateThreadMessageOutcomeInput,
): Promise<ThreadMessage | null> {
  const patch: Record<string, unknown> = {};
  if (args.traceId) patch.trace_id = args.traceId;
  if (args.usedPrivate) patch.used_private = true;
  const [row] = await systemDb
    .update(assistantMessages)
    .set({
      status: args.status,
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
      ...(Object.keys(patch).length > 0
        ? { data: dsql`${assistantMessages.data} || ${JSON.stringify(patch)}::jsonb` }
        : {}),
    })
    .where(
      and(
        eq(assistantMessages.ownerId, args.ownerId),
        eq(assistantMessages.loginId, args.loginId),
        eq(assistantMessages.id, args.id),
      ),
    )
    .returning();
  return row ? threadMessage(row) : null;
}

/**
 * The most recent `limit` rows of one login's thread with one agent, in
 * ASCENDING order (the context-loader shape). `since` bounds it to the open
 * chat thread ("New chat"). Read on the caller's pool: inside the workspace
 * turn scope, row security also holds it to the login's own rows.
 */
export async function recentThreadMessages(
  ownerId: string,
  agentId: string,
  loginId: string,
  limit = 30,
  since?: Date | null,
): Promise<ThreadMessage[]> {
  const rows = await db
    .select()
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.agentId, agentId),
        eq(assistantMessages.loginId, loginId),
        ...(since ? [gte(assistantMessages.createdAt, since)] : []),
      ),
    )
    .orderBy(desc(assistantMessages.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  rows.reverse();
  return rows.map(threadMessage);
}

/** One row of a login's own thread by id, or null (another login's row is
 *  never found). For the turn's own tools (team_request_create). */
export async function threadMessageById(
  ownerId: string,
  loginId: string,
  id: string,
): Promise<ThreadMessage | null> {
  const [row] = await db
    .select()
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.loginId, loginId),
        eq(assistantMessages.id, id),
      ),
    )
    .limit(1);
  return row ? threadMessage(row) : null;
}

/** What an admin reads instead of a reply that may quote the member's
 *  private items (audit S3: admins never see a member's private items). */
export const PRIVATE_REPLY_PLACEHOLDER =
  "[This reply used the member's private items. It is not shown to admins.]";

/** A thread row as an admin may read it: a reply marked `usedPrivate` loses
 *  its text and attachments. */
export function redactPrivateReply(row: TeamMessage): TeamMessage {
  return row.usedPrivate ? { ...row, text: PRIVATE_REPLY_PLACEHOLDER, attachments: [] } : row;
}

/**
 * A window of one team-portal contact's OLD thread (history only: the
 * team-code portal was retired, and its rows have no login), newest-first
 * from `before` (exclusive), returned in ASCENDING order. Replies marked
 * `usedPrivate` are redacted. Never a login's thread: those are read only by
 * their own login (0269).
 */
export async function listTeamThread(
  ownerId: string,
  contactId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<TeamMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = [
    eq(teamMessages.ownerId, ownerId),
    eq(teamMessages.contactId, contactId),
    isNull(teamMessages.loginId),
  ];
  if (opts.before) {
    const cursor = new Date(opts.before);
    if (!Number.isNaN(cursor.getTime())) conds.push(lt(teamMessages.createdAt, cursor));
  }
  const rows = await systemDb
    .select()
    .from(teamMessages)
    .where(and(...conds))
    .orderBy(desc(teamMessages.createdAt))
    .limit(limit);
  rows.reverse();
  return rows.map(redactPrivateReply);
}

/**
 * The old portal chat index (the Members tab's "Chat archive" roster): every
 * contact of this owner with portal chat rows (a contact, no login),
 * annotated with its thread's first and last message, size and unread
 * count. Driven by the chat itself since team codes were retired (0178);
 * it listed code holders before, so a contact whose code was redeemed or
 * never used to chat dropped off, and one that chats stays. Newest activity
 * first. `memberSince` is the first portal message.
 */
export async function listTeamMemberActivity(ownerId: string): Promise<TeamMemberActivity[]> {
  const result = await db.execute(dsql`
    select n.id as contact_id,
           n.title as contact_name,
           portal.first_at,
           portal.n as message_count,
           last_msg.created_at as last_at,
           last_msg.text as last_text,
           last_msg.direction as last_direction,
           -- Inbound (member to brain) messages newer than the owner's read
           -- cursor (no cursor row: epoch, so all inbound counts as unread).
           (select count(*)
              from team_messages tmu
             where tmu.owner_id = n.owner_id
               and tmu.contact_id = n.id
               and tmu.login_id is null
               and tmu.direction = 'inbound'
               and tmu.created_at > coalesce(
                 (select c.last_read_at from team_read_cursors c
                   where c.owner_id = n.owner_id and c.contact_id = n.id),
                 'epoch'::timestamptz))::int as unread
      from (select tm.contact_id, min(tm.created_at) as first_at, count(*)::int as n
              from team_messages tm
             where tm.owner_id = ${ownerId}
               and tm.contact_id is not null
               and tm.login_id is null
             group by tm.contact_id) portal
      join nodes n on n.id = portal.contact_id and n.owner_id = ${ownerId}
      cross join lateral (
        select tl.created_at, tl.text, tl.direction
          from team_messages tl
         where tl.owner_id = n.owner_id
           and tl.contact_id = n.id
           and tl.login_id is null
         order by tl.created_at desc
         limit 1
      ) last_msg
     order by last_msg.created_at desc
  `);
  const rows = result as unknown as Array<{
    contact_id: string;
    contact_name: string | null;
    first_at: string | Date;
    message_count: number;
    last_at: string | Date;
    last_text: string;
    last_direction: string;
    unread: number;
  }>;
  const iso = (v: string | Date) => new Date(v).toISOString();
  return rows.map((r) => ({
    contactId: r.contact_id,
    contactName: r.contact_name ?? '(unnamed contact)',
    memberSince: iso(r.first_at),
    lastMessageAt: iso(r.last_at),
    lastMessageText: r.last_text,
    lastMessageDirection: r.last_direction as 'inbound' | 'outbound',
    messageCount: Number(r.message_count),
    unread: Number(r.unread),
  }));
}
