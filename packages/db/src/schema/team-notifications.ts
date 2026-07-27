import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Member-to-member notifications — "let Deepthi know to check this thread".
 *
 * The gap this fills, from a real Pinnacle forum topic (2026-07-21): a member
 * asked the responder to notify a colleague, and it correctly answered that it
 * had no way to reach anyone — so the ask degraded to "go tell her yourself,
 * and point her at this thread by hand", while the responder was SITTING in
 * that thread and knew its id.
 *
 * ── Why a thread, not a toast ────────────────────────────────────────────────
 * The recipient replies without leaving what they're doing, so this is modelled
 * as a conversation from the start rather than a fire-and-forget ping that
 * later grows a reply box. `thread_id` groups a notification with its replies;
 * the ROOT row carries its own id there, every reply carries the root's. That
 * keeps "one notification and its replies" a single indexed read and makes the
 * root discoverable from any reply without a recursive walk.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 * `recipient_id` / `sender_id` hold a contact node id for a member, or the
 * OWNER's id for the owner — the same dual convention as
 * `forum_read_cursors.reader_id`, and the reason there is no FK on them (the
 * owner is not a node). A deleted contact's rows are inert junk; every read
 * path joins live contacts, and `sender_name` is captured at send time so a
 * thread stays readable after the sender is revoked.
 *
 * ── Provenance ──────────────────────────────────────────────────────────────
 * `topic_id` / `post_id` are stamped from the turn's authenticated surface
 * context, never from model args — the same discipline as
 * `team_request_create`. They are what turns "notify her about this" into a
 * link she can click instead of a title she has to search for.
 *
 * `read_at` is per-row: the popup must not re-fire on every mount, and
 * `refetchOnWindowFocus` is FALSE app-wide, so a surface that misses the
 * realtime repaint never self-heals on its own.
 */
export const teamNotifications = pgTable(
  'team_notifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** Root notification id. The root row carries its OWN id here. */
    threadId: uuid('thread_id').notNull(),
    /** Contact node id, or the owner's id when the owner is the recipient. */
    recipientId: uuid('recipient_id').notNull(),
    /** Contact node id, or the owner's id when the owner is the sender. */
    senderId: uuid('sender_id').notNull(),
    /** Sender's display name at send time — survives the contact's deletion. */
    senderName: text('sender_name'),
    body: text('body').notNull(),
    /** Forum topic this came from, for the deep link. Null = no thread context. */
    topicId: uuid('topic_id'),
    /** The specific post, when the responder was answering one. */
    postId: uuid('post_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The inbox query: this person's notifications, newest first.
    index('team_notifications_inbox_idx').on(t.ownerId, t.recipientId, t.createdAt.desc()),
    // One thread and its replies, in order.
    index('team_notifications_thread_idx').on(t.threadId, t.createdAt),
  ],
);

export type TeamNotification = typeof teamNotifications.$inferSelect;
export type NewTeamNotification = typeof teamNotifications.$inferInsert;
