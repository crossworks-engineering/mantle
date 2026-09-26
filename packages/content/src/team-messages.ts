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
  teamReadCursors,
  contactTeamTokens,
  nodes,
  type ConversationAttachment,
  type TeamChannel,
  type TeamMessage,
} from '@mantle/db';
import type { TeamMemberActivity } from '@mantle/client-types';

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
  opts: { before?: string; limit?: number; loginId?: string } = {},
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
  return rows.reverse();
}

/** Most recent N turns of a thread in ASCENDING order — the context-loader
 *  shape (mirror of recentAssistantMessages). */
export async function recentTeamMessages(
  ownerId: string,
  contactId: string,
  limit = 30,
  loginId?: string,
): Promise<TeamMessage[]> {
  return listTeamThread(ownerId, contactId, { limit, ...(loginId ? { loginId } : {}) });
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
 * The team-CODE holder index: every contact with a live
 * contact_team_tokens row (the retired portal's membership), annotated with their thread's last
 * message + size + unread count. Ordered newest-activity-first in SQL, NULLS
 * LAST so a freshly enabled member with no thread still shows (at the bottom).
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
      // Inbound (member→brain) messages newer than the owner's read cursor —
      // a self-contained correlated subquery (no cursor row ⇒ epoch ⇒ all
      // inbound counts as unread).
      unread: dsql<number>`(
        select count(*)
        from team_messages tmu
        where tmu.owner_id = ${contactTeamTokens.ownerId}
          and tmu.contact_id = ${contactTeamTokens.contactId}
          and tmu.login_id is null
          and tmu.direction = 'inbound'
          and tmu.created_at > coalesce(
            (select c.last_read_at from team_read_cursors c
             where c.owner_id = ${contactTeamTokens.ownerId}
               and c.contact_id = ${contactTeamTokens.contactId}),
            'epoch'::timestamptz
          )
      )::int`,
    })
    .from(contactTeamTokens)
    .innerJoin(nodes, eq(nodes.id, contactTeamTokens.contactId))
    .leftJoin(
      dsql`lateral (
        select tm.created_at, tm.text, tm.direction
        from team_messages tm
        where tm.owner_id = ${contactTeamTokens.ownerId}
          and tm.contact_id = ${contactTeamTokens.contactId}
          and tm.login_id is null
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
          and tm.login_id is null
      ) msg_counts`,
      dsql`true`,
    )
    .where(eq(contactTeamTokens.ownerId, ownerId))
    .orderBy(dsql`last_msg.created_at desc nulls last`);

  return rows.map((r) => ({
    contactId: r.contactId,
    contactName: r.contactName ?? '(unnamed contact)',
    memberSince: r.memberSince.toISOString(),
    tokenLastUsedAt: r.tokenLastUsedAt ? r.tokenLastUsedAt.toISOString() : null,
    lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
    lastMessageText: r.lastMessageText,
    lastMessageDirection: (r.lastMessageDirection ?? null) as 'inbound' | 'outbound' | null,
    messageCount: r.messageCount,
    unread: r.unread,
  }));
}

/** One member login and its chat thread, for the owner's views. */
export type MemberChatActivity = {
  loginId: string;
  /** Display name, else the part of the email before the @ (the name the
   *  agent uses for the member). */
  name: string;
  email: string;
  /** False when the login is disabled or no longer a member (its old
   *  thread still shows). */
  active: boolean;
  lastMessageAt: string | null;
  lastMessageText: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  messageCount: number;
};

/**
 * The owner's index of member chats (users are the team): every member login,
 * plus any other login that still has a thread, annotated with its thread's
 * last message and size. Newest activity first, NULLS LAST so a new member
 * with no thread still shows. The retired team-code portal threads are not
 * here; `listTeamMemberActivity` still indexes those as history.
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
      messageCount: dsql<number>`coalesce(msg_counts.n, 0)::int`,
    })
    .from(authUsers)
    .leftJoin(
      dsql`lateral (
        select tm.created_at, tm.text, tm.direction
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
    lastMessageText: r.lastMessageText,
    lastMessageDirection: (r.lastMessageDirection ?? null) as 'inbound' | 'outbound' | null,
    messageCount: r.messageCount,
  }));
}

/** Mark a member's thread read up to now (owner opened it in /team-admin).
 *  Upsert on the composite PK. Best-effort — a failed cursor write must never
 *  break the admin view. */
export async function markTeamThreadRead(ownerId: string, contactId: string): Promise<void> {
  await db
    .insert(teamReadCursors)
    .values({ ownerId, contactId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [teamReadCursors.ownerId, teamReadCursors.contactId],
      set: { lastReadAt: new Date() },
    })
    .catch(() => {
      /* best-effort — the unread badge is a convenience, not a gate */
    });
}
