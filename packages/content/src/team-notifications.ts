/**
 * Member-to-member notifications with reply-in-place.
 *
 * See `packages/db/src/schema/team-notifications.ts` for the data model and
 * why it is a thread rather than a toast. This module is the whole read/write
 * surface: the tools, the member API routes and the owner dash all go through
 * it, so the membership gate below is enforced in exactly one place.
 *
 * THE GATE. A notification may only be addressed to a LIVE team member of this
 * brain (or the owner). That is the entire authorization story, and it is
 * deliberately a live `contact_team_tokens` check rather than a "was a member
 * once" flag — revoking membership must stop delivery mid-flight, the same
 * per-request liveness rule every other external surface follows. There is no
 * free-text address anywhere in this module: a recipient is always an id the
 * caller obtained from `listNotifiableMembers`, re-verified here.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, contactTeamTokens, nodes, teamNotifications } from '@mantle/db';

/**
 * The Postgres channel a recipient's surfaces repaint on. Nothing in
 * TypeScript raises it — migration 0138 puts triggers on the table, for the
 * same reason 0135 does on `runs`: a hand-placed notify is only correct until
 * the next write path forgets one, and a trigger cannot be bypassed.
 *
 * Named here so the SQL producer and its consumers are joined by one symbol
 * rather than copies of a string literal. Payload is JSON
 * `{ownerId, recipientId}` — deliberately NOT the bare owner id the
 * `runs_changed` / `pending_changed` convention uses, because a notification is
 * per-RECIPIENT state: broadcasting owner-wide would wake every connected
 * surface for a message meant for one person.
 */
export const TEAM_NOTIFICATION_CHANNEL = 'team_notification_changed';

/** The realtime change `type` the bridge broadcasts for
 *  {@link TEAM_NOTIFICATION_CHANNEL}. */
export const TEAM_NOTIFICATION_TYPE = 'team_notification';

/** How many notifications one send may address. A responder turn is driven by
 *  a member's free text, so "tell everyone" must not become a fan-out weapon —
 *  and a genuine ask names one or two people. */
export const MAX_NOTIFY_RECIPIENTS = 5;

/** Max body length. Long enough for real context, short enough that a browser
 *  notification and a dash card can show it whole. */
export const MAX_NOTIFICATION_BODY = 2000;

export type NotifiableMember = {
  /** Contact node id — what `notifyMembers` takes as a recipient. */
  id: string;
  name: string;
};

export type TeamNotificationRow = {
  id: string;
  threadId: string;
  recipientId: string;
  senderId: string;
  senderName: string | null;
  body: string;
  topicId: string | null;
  postId: string | null;
  readAt: string | null;
  createdAt: string;
};

/**
 * The members a notification may be addressed to: live team members of this
 * brain, name + id only.
 *
 * Deliberately NOT `listTeamMemberActivity` (the owner-side index behind
 * `team_chat_list`), which returns token-last-used and per-member activity
 * metadata no member should see about a colleague. This is the member-facing
 * projection: enough to resolve "Deepthi" to a recipient, nothing more.
 */
export async function listNotifiableMembers(ownerId: string): Promise<NotifiableMember[]> {
  const rows = await db
    .select({ id: nodes.id, name: nodes.title })
    .from(contactTeamTokens)
    .innerJoin(nodes, eq(nodes.id, contactTeamTokens.contactId))
    .where(and(eq(contactTeamTokens.ownerId, ownerId), eq(nodes.ownerId, ownerId)))
    .orderBy(asc(nodes.title));
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export type NotifyInput = {
  recipientIds: string[];
  senderId: string;
  senderName?: string | null;
  body: string;
  /** Forum provenance — stamped from the authenticated surface, never args. */
  topicId?: string | null;
  postId?: string | null;
};

export type NotifyResult = {
  /** Rows actually written, one per accepted recipient. */
  delivered: { recipientId: string; notificationId: string }[];
  /** Recipient ids refused because they are not live team members. */
  rejected: string[];
};

/**
 * Send one notification to each recipient. Each becomes its OWN thread root
 * (its own id in `thread_id`) — two people notified about the same thing hold
 * two independent conversations, because a reply is to the sender, not to a
 * group the recipient never agreed to join.
 *
 * Non-members are dropped and REPORTED rather than failing the whole call: the
 * caller is a language model resolving names, and one bad id shouldn't discard
 * the deliveries that were correct. The caller is expected to relay `rejected`
 * back to the member who asked.
 */
export async function notifyMembers(ownerId: string, input: NotifyInput): Promise<NotifyResult> {
  const body = input.body.trim().slice(0, MAX_NOTIFICATION_BODY);
  if (!body) throw new Error('notifyMembers: body is required');

  const wanted = [...new Set(input.recipientIds.filter(Boolean))];
  if (wanted.length === 0) return { delivered: [], rejected: [] };
  // Over-cap is an ERROR, never a silent slice. The tool schema's maxItems
  // only blocks in 'enforce' validation mode (the fleet default is 'warn'),
  // so this is the cap that actually holds — and dropping recipient six
  // while reporting success would tell the member everyone was notified
  // when they weren't, the exact failure this feature exists to remove.
  if (wanted.length > MAX_NOTIFY_RECIPIENTS) {
    throw new Error(
      `notifyMembers: at most ${MAX_NOTIFY_RECIPIENTS} recipients per send (got ${wanted.length}) — ` +
        'narrow the list, or send in separate calls if they genuinely all need it.',
    );
  }

  // The gate: live membership, re-checked here rather than trusted from the
  // caller's earlier lookup — the two are separated by a whole model turn.
  // The owner is always addressable and holds no contact_team_tokens row.
  const live = await db
    .select({ contactId: contactTeamTokens.contactId })
    .from(contactTeamTokens)
    .where(
      and(eq(contactTeamTokens.ownerId, ownerId), inArray(contactTeamTokens.contactId, wanted)),
    );
  const allowed = new Set(live.map((r) => r.contactId));
  if (wanted.includes(ownerId)) allowed.add(ownerId);

  const accepted = wanted.filter((id) => allowed.has(id));
  const rejected = wanted.filter((id) => !allowed.has(id));
  if (accepted.length === 0) return { delivered: [], rejected };

  const rows = await db
    .insert(teamNotifications)
    .values(
      accepted.map((recipientId) => {
        // Ids are generated HERE rather than by the column default so a root
        // can point `thread_id` at itself in the same INSERT. Filling it
        // afterwards would leave a window — the insert trigger has already
        // fired and woken the recipient — in which the root is unreachable by
        // the only key the read paths use.
        const id = randomUUID();
        return {
          id,
          ownerId,
          threadId: id,
          recipientId,
          senderId: input.senderId,
          senderName: input.senderName ?? null,
          body,
          topicId: input.topicId ?? null,
          postId: input.postId ?? null,
        };
      }),
    )
    .returning({ id: teamNotifications.id, recipientId: teamNotifications.recipientId });

  return {
    delivered: rows.map((r) => ({ recipientId: r.recipientId, notificationId: r.id })),
    rejected,
  };
}

/** Reply into an existing thread. The reply is addressed to the OTHER party of
 *  the root — you reply to whoever you're talking to, and the thread has
 *  exactly two ends by construction. */
export async function replyToNotification(
  ownerId: string,
  threadId: string,
  senderId: string,
  body: string,
  senderName?: string | null,
): Promise<TeamNotificationRow | null> {
  const text = body.trim().slice(0, MAX_NOTIFICATION_BODY);
  if (!text) throw new Error('replyToNotification: body is required');

  const [root] = await db
    .select({
      recipientId: teamNotifications.recipientId,
      senderId: teamNotifications.senderId,
    })
    .from(teamNotifications)
    .where(and(eq(teamNotifications.ownerId, ownerId), eq(teamNotifications.id, threadId)))
    .limit(1);
  if (!root) return null;

  // Only the two ends of the thread may post into it.
  if (senderId !== root.recipientId && senderId !== root.senderId) return null;
  const recipientId = senderId === root.recipientId ? root.senderId : root.recipientId;

  const [row] = await db
    .insert(teamNotifications)
    .values({
      ownerId,
      threadId,
      recipientId,
      senderId,
      senderName: senderName ?? null,
      body: text,
    })
    .returning();
  return row ? toRow(row) : null;
}

/** One person's inbox, newest thread-root first. Replies are fetched per
 *  thread by `readThread` — the dash shows roots and expands on open. */
export async function listNotifications(
  ownerId: string,
  recipientId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<TeamNotificationRow[]> {
  const where = [
    eq(teamNotifications.ownerId, ownerId),
    eq(teamNotifications.recipientId, recipientId),
  ];
  if (opts.unreadOnly) where.push(isNull(teamNotifications.readAt));
  const rows = await db
    .select()
    .from(teamNotifications)
    .where(and(...where))
    .orderBy(desc(teamNotifications.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  return rows.map(toRow);
}

/**
 * A whole thread in order — the root and every reply — for one PARTICIPANT.
 *
 * `readerId` is required and checked against the root's two ends, because
 * this module is where the gate lives (see the header): an API route that
 * passed only ids from the URL would otherwise let any member read any
 * colleague's thread. A non-participant (or a missing thread — deliberately
 * indistinguishable, so the response doesn't confirm a thread id exists)
 * gets an empty list.
 */
export async function readThread(
  ownerId: string,
  threadId: string,
  readerId: string,
): Promise<TeamNotificationRow[]> {
  const rows = await db
    .select()
    .from(teamNotifications)
    .where(and(eq(teamNotifications.ownerId, ownerId), eq(teamNotifications.threadId, threadId)))
    .orderBy(asc(teamNotifications.createdAt));
  const root = rows.find((r) => r.id === r.threadId);
  if (!root || (readerId !== root.recipientId && readerId !== root.senderId)) return [];
  return rows.map(toRow);
}

/** Mark this person's rows in a thread read. Scoped to the READER's own rows:
 *  reading your copy must never mark the other end's copy read. */
export async function markThreadRead(
  ownerId: string,
  threadId: string,
  recipientId: string,
): Promise<number> {
  const rows = await db
    .update(teamNotifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(teamNotifications.ownerId, ownerId),
        eq(teamNotifications.threadId, threadId),
        eq(teamNotifications.recipientId, recipientId),
        isNull(teamNotifications.readAt),
      ),
    )
    .returning({ id: teamNotifications.id });
  return rows.length;
}

/** Unread count for the dash badge. */
export async function countUnreadNotifications(
  ownerId: string,
  recipientId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(teamNotifications)
    .where(
      and(
        eq(teamNotifications.ownerId, ownerId),
        eq(teamNotifications.recipientId, recipientId),
        isNull(teamNotifications.readAt),
      ),
    );
  return row?.n ?? 0;
}

function toRow(r: typeof teamNotifications.$inferSelect): TeamNotificationRow {
  return {
    id: r.id,
    threadId: r.threadId,
    recipientId: r.recipientId,
    senderId: r.senderId,
    senderName: r.senderName,
    body: r.body,
    topicId: r.topicId,
    postId: r.postId,
    readAt: r.readAt ? r.readAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}
