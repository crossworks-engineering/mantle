/**
 * Team chat conversation store. One forever-thread per member LOGIN
 * (`login_id`), the external mirror of the per-agent `assistant_messages`
 * model. Writers are the team turn pipeline (inbound member text, outbound
 * responder reply); readers are the member's own thread view, the admin
 * views, and the owner-side `team_chat_*` tools.
 *
 * Rows keyed by a contact (`contact_id`, no login) are the retired team-code
 * portal chat: history only, read by the admin archive and `team_chat_read`.
 */
import { and, count, desc, eq, gte, isNull, lt, or, sql as dsql } from 'drizzle-orm';
import {
  authUsers,
  db,
  systemDb,
  teamMessages,
  type ConversationAttachment,
  type TeamChannel,
  type TeamMessage,
} from '@mantle/db';
import type { MemberChatRow, TeamMemberActivity } from '@mantle/client-types';

// The member's thread (team_messages) is infrastructure in the access matrix:
// a team turn runs under the team viewer role (member logins Phase 0b) and
// still reads and writes its own thread, so those helpers use systemDb.
export type { TeamMemberActivity };

export type AppendTeamMessageInput = {
  ownerId: string;
  /** The team portal contact. Null for a member LOGIN's turn (0167): the
   *  login is the team member, and `loginId` names the thread. */
  contactId: string | null;
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
  /** A member login's turn: the row joins that login's own thread. */
  loginId?: string | null;
};

/** Persist one turn row. Not fire-and-forget — the transcript IS the product
 *  here, so failures must surface to the turn pipeline. */
export async function appendTeamMessage(input: AppendTeamMessageInput): Promise<TeamMessage> {
  const [row] = await systemDb
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
      loginId: input.loginId ?? null,
    })
    .returning();
  if (!row) throw new Error('appendTeamMessage: insert returned no row');
  return row;
}

export type UpdateTeamMessageOutcomeInput = {
  ownerId: string;
  id: string;
  status: 'complete' | 'failed';
  text?: string;
  model?: string | null;
  traceId?: string | null;
  error?: string | null;
  /** Media the turn's tools produced — node references only, never bytes. See
   *  the note in run-team-turn.ts for why this is written HERE and not left to
   *  the live channel. */
  attachments?: ConversationAttachment[];
  /** The reply may quote the member's private items (audit S3). */
  usedPrivate?: boolean;
};

/** Finalize a pending outbound row (the durable "thinking…" bubble): fill the
 *  reply + flip status, or mark it failed. Mirrors updateAssistantMessageOutcome.
 *  Returns the updated row, or null if it vanished. */
export async function updateTeamMessageOutcome(
  args: UpdateTeamMessageOutcomeInput,
): Promise<TeamMessage | null> {
  const [row] = await systemDb
    .update(teamMessages)
    .set({
      status: args.status,
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
      ...(args.usedPrivate ? { usedPrivate: true } : {}),
    })
    .where(and(eq(teamMessages.ownerId, args.ownerId), eq(teamMessages.id, args.id)))
    .returning();
  return row ?? null;
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
 * A window of one contact's thread, newest-first from `before` (exclusive),
 * returned in ASCENDING order for rendering. `before` is an ISO timestamp
 * cursor (the createdAt of the oldest message the caller already has).
 *
 * Replies marked `usedPrivate` are REDACTED unless `withPrivate` is set: only
 * the member's own reads (their chat view, the turn's history) pass it, so an
 * admin path cannot forget to hide them.
 */
export async function listTeamThread(
  ownerId: string,
  contactId: string,
  opts: { before?: string; limit?: number; loginId?: string; withPrivate?: boolean } = {},
): Promise<TeamMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // A member login's thread is its own: keyed by the login, never by the
  // contact (the contact's team-portal rows are a different thread).
  const conds = opts.loginId
    ? [eq(teamMessages.ownerId, ownerId), eq(teamMessages.loginId, opts.loginId)]
    : [
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
  return opts.withPrivate ? rows : rows.map(redactPrivateReply);
}

/**
 * A member login's OLD team portal chat, for the admin: a window of the
 * thread its contact (`auth.users.contact_id`, the contact it was invited
 * from) had on the team code. Rows with a login are never here, so this is
 * never the member's live thread, and it is always redacted like any admin
 * read. Null when the login has no contact. The member's own reads and the
 * turn's context never call this (Jason, 2026-09-28: old portal transcripts
 * are not merged into the live thread, which the model reads).
 */
export async function listLoginPortalThread(
  ownerId: string,
  loginId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<{ contactId: string; messages: TeamMessage[] } | null> {
  const [login] = await systemDb
    .select({ contactId: authUsers.contactId })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!login?.contactId) return null;
  const messages = await listTeamThread(ownerId, login.contactId, {
    limit: opts.limit ?? 50,
    ...(opts.before ? { before: opts.before } : {}),
  });
  return { contactId: login.contactId, messages };
}

/** Most recent N turns of a thread in ASCENDING order — the context-loader
 *  shape (mirror of recentAssistantMessages). The member's own turn: private
 *  replies included. */
export async function recentTeamMessages(
  ownerId: string,
  contactId: string,
  limit = 30,
  loginId?: string,
): Promise<TeamMessage[]> {
  return listTeamThread(ownerId, contactId, {
    limit,
    withPrivate: true,
    ...(loginId ? { loginId } : {}),
  });
}

/** Inbound turns a member LOGIN has sent since `since`: the member chat's
 *  daily-cap gate (users are the team; a member needs no contact). */
export async function countMemberInboundSince(
  ownerId: string,
  loginId: string,
  since: Date,
): Promise<number> {
  const [row] = await systemDb
    .select({ n: count() })
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.ownerId, ownerId),
        eq(teamMessages.loginId, loginId),
        eq(teamMessages.direction, 'inbound'),
        gte(teamMessages.createdAt, since),
      ),
    );
  return row?.n ?? 0;
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

/** One member login and its chat thread, for the owner's views: the
 *  published contract row (GET /api/team-admin/member-chats). The name is
 *  the display name, else the part of the email before the @ (the name the
 *  agent uses for the member). */
export type MemberChatActivity = MemberChatRow;

/**
 * The owner's index of member chats (users are the team): every member login,
 * plus any other login that still has a thread, annotated with its thread's
 * last message and size. Newest activity first, NULLS LAST so a new member
 * with no thread still shows. The retired team-code portal threads are not
 * here; `listTeamMemberActivity` indexes those as history.
 */
export async function listMemberChatActivity(ownerId: string): Promise<MemberChatActivity[]> {
  const rows = await systemDb
    .select({
      loginId: authUsers.id,
      displayName: authUsers.displayName,
      email: authUsers.email,
      role: authUsers.role,
      disabledAt: authUsers.disabledAt,
      lastMessageAt: dsql<string | null>`last_msg.created_at`,
      lastMessageText: dsql<string | null>`last_msg.text`,
      lastMessageDirection: dsql<string | null>`last_msg.direction`,
      lastMessagePrivate: dsql<boolean | null>`last_msg.used_private`,
      messageCount: dsql<number>`coalesce(msg_counts.n, 0)::int`,
    })
    .from(authUsers)
    .leftJoin(
      dsql`lateral (
        select tm.created_at, tm.text, tm.direction, tm.used_private
        from team_messages tm
        where tm.owner_id = ${ownerId} and tm.login_id = ${authUsers.id}
        order by tm.created_at desc
        limit 1
      ) last_msg`,
      dsql`true`,
    )
    .leftJoin(
      dsql`lateral (
        select count(*) as n
        from team_messages tm
        where tm.owner_id = ${ownerId} and tm.login_id = ${authUsers.id}
      ) msg_counts`,
      dsql`true`,
    )
    .where(or(eq(authUsers.role, 'member'), dsql`coalesce(msg_counts.n, 0) > 0`))
    .orderBy(dsql`last_msg.created_at desc nulls last`, authUsers.email);

  return rows.map((r) => ({
    loginId: r.loginId,
    name: r.displayName?.trim() || r.email.split('@')[0] || 'team member',
    email: r.email,
    active: r.role === 'member' && !r.disabledAt,
    lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
    // An admin view (the Member chats list, team_chat_list): a private reply
    // shows the placeholder (audit S3).
    lastMessageText: r.lastMessagePrivate ? PRIVATE_REPLY_PLACEHOLDER : r.lastMessageText,
    lastMessageDirection: (r.lastMessageDirection ?? null) as 'inbound' | 'outbound' | null,
    messageCount: r.messageCount,
  }));
}
