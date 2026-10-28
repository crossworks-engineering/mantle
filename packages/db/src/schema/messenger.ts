import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { workspaces } from './workspaces';

/**
 * The messenger (migration 0335, plan page d8954876 section 11): direct
 * chats and groups between the logins of one brain. Row security keys every
 * read on the participant row (mantle_messenger_seq_cap); every write goes
 * through @mantle/content/messenger on the system pool. The FKs into
 * `auth.users` are declared in the SQL migration (cross-schema).
 */

/** The last line of a conversation, kept in its row by the send. */
export type MessengerPreviewJson = {
  authorName: string | null;
  text: string;
  authorKind: 'login' | 'agent' | 'system';
};

/** A mention in a message: a login or an agent. */
export type MessengerMentionJson = { kind: 'login' | 'agent'; id: string };

/** What a system line marks (calls plan section 8): a call started, ended,
 *  or cut at the cap. The client tells them apart by `type`. */
export type MessengerEventJson =
  | { type: 'call_started'; callId: string }
  | { type: 'call_ended'; callId: string; seconds: number; participants: number }
  | { type: 'call_cap'; callId: string; seconds: number; participants: number };

export type MessengerCallEndedReason =
  'finished' | 'cap_reached' | 'closed_by_admin' | 'service_off' | 'reconciled';

export const messengerConversations = pgTable('messenger_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  kind: text('kind').$type<'direct' | 'group'>().notNull(),
  title: text('title'),
  pictureAttachmentId: uuid('picture_attachment_id'),
  /** A group's icon, an emoji (0341); null for a direct chat. */
  icon: text('icon'),
  /** A group's colour, an app tint key (APP_TINTS, 0341); null for a direct chat. */
  color: text('color'),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  /** A direct chat's two login ids, sorted and joined; null for a group. */
  directKey: text('direct_key'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  lastSeq: bigint('last_seq', { mode: 'number' }).default(0).notNull(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  lastPreview: jsonb('last_preview').$type<MessengerPreviewJson>(),
  /** Calls plan section 7 (P3): the group's agent answers with a voice note
   *  too. Stored from 0342, read by nothing in P1. */
  voiceReplies: boolean('voice_replies').default(false).notNull(),
});

export const messengerParticipants = pgTable('messenger_participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => messengerConversations.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'login' | 'agent'>().notNull(),
  loginId: uuid('login_id'),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  /** A group admin (the creator first); a direct chat has none. */
  admin: boolean('admin').default(false).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  addedBy: uuid('added_by'),
  leftAt: timestamp('left_at', { withTimezone: true }),
  /** Set with left_at: the participant reads up to here and nothing after. */
  leftSeq: bigint('left_seq', { mode: 'number' }),
  lastReadSeq: bigint('last_read_seq', { mode: 'number' }).default(0).notNull(),
  mentionSeq: bigint('mention_seq', { mode: 'number' }).default(0).notNull(),
  clearedBeforeSeq: bigint('cleared_before_seq', { mode: 'number' }).default(0).notNull(),
  /** A login added later reads only the seqs above this (its add line on). */
  fromSeq: bigint('from_seq', { mode: 'number' }).default(0).notNull(),
  muted: boolean('muted').default(false).notNull(),
});

export const messengerMessages = pgTable('messenger_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => messengerConversations.id, { onDelete: 'cascade' }),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  authorKind: text('author_kind').$type<'login' | 'agent' | 'system'>().notNull(),
  authorLoginId: uuid('author_login_id'),
  authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  authorName: text('author_name'),
  /** The label shown: an OAuth client name, a key label, a peer name. */
  via: text('via'),
  /** The credential: oauth:<client id>, key:<key id>, peer:<peer id>. */
  viaRef: text('via_ref'),
  body: text('body').default('').notNull(),
  attachments: jsonb('attachments').$type<string[]>().default([]).notNull(),
  mentions: jsonb('mentions').$type<MessengerMentionJson[]>().default([]).notNull(),
  replyToSeq: bigint('reply_to_seq', { mode: 'number' }),
  clientMsgId: text('client_msg_id'),
  status: text('status').$type<'complete' | 'pending' | 'failed'>().default('complete').notNull(),
  turnId: uuid('turn_id'),
  error: text('error'),
  /** A system line that marks a call (0342): {type, callId, ...}; null on
   *  an ordinary row. */
  event: jsonb('event').$type<MessengerEventJson>(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const messengerAttachments = pgTable('messenger_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => messengerConversations.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id').references(() => messengerMessages.id, { onDelete: 'cascade' }),
  uploaderLoginId: uuid('uploader_login_id'),
  kind: text('kind').$type<'image' | 'file' | 'voice' | 'audio' | 'video'>().notNull(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  path: text('path').notNull(),
  durationMs: integer('duration_ms'),
  width: integer('width'),
  height: integer('height'),
  thumbPath: text('thumb_path'),
  transcript: text('transcript'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const messengerReactions = pgTable(
  'messenger_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messengerMessages.id, { onDelete: 'cascade' }),
    loginId: uuid('login_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.loginId, t.emoji] })],
);

/** The pins of the one list: a conversation, or an agent thread. */
export const messengerFavourites = pgTable(
  'messenger_favourites',
  {
    loginId: uuid('login_id').notNull(),
    kind: text('kind').$type<'conversation' | 'agent'>().notNull(),
    refId: uuid('ref_id').notNull(),
    rank: integer('rank').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.loginId, t.kind, t.refId] })],
);

/** "Online": the messenger stream's heartbeat, at most once a minute. */
export const loginPresence = pgTable('login_presence', {
  loginId: uuid('login_id').primaryKey(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A call (0342, calls plan section 8): a LiveKit room named after the
 * conversation, opened by a participant's tap and closed by the webhook,
 * the reconciler, an admin or the service switch. started_seq is the seq of
 * its "call started" line: row security answers the row as it answers
 * that line. Written only by @mantle/content/messenger-calls.
 */
export const messengerCalls = pgTable('messenger_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => messengerConversations.id, { onDelete: 'cascade' }),
  roomName: text('room_name').notNull(),
  kind: text('kind').$type<'audio' | 'video'>().default('audio').notNull(),
  startedBy: uuid('started_by'),
  startedSeq: bigint('started_seq', { mode: 'number' }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endedReason: text('ended_reason').$type<MessengerCallEndedReason>(),
  durationS: integer('duration_s'),
  maxParticipants: integer('max_participants').default(0).notNull(),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  agentSeconds: integer('agent_seconds').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One stay in a call (0342): written by the webhook handler, corrected by
 *  the reconciler. A login that leaves and joins again has two rows. */
export const messengerCallParticipants = pgTable('messenger_call_participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  callId: uuid('call_id')
    .notNull()
    .references(() => messengerCalls.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'login' | 'agent'>().notNull(),
  loginId: uuid('login_id'),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  leftAt: timestamp('left_at', { withTimezone: true }),
  /** What the client said it is (web, desktop, phone). */
  device: text('device'),
});

/** The LiveKit webhook's replay guard (0342): one row per event id. */
export const messengerCallWebhooks = pgTable('messenger_call_webhooks', {
  eventId: text('event_id').primaryKey(),
  event: text('event').notNull(),
  roomName: text('room_name'),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
});

export type MessengerConversationRow = typeof messengerConversations.$inferSelect;
export type MessengerCallRow = typeof messengerCalls.$inferSelect;
export type MessengerCallParticipantRow = typeof messengerCallParticipants.$inferSelect;
export type MessengerParticipantRow = typeof messengerParticipants.$inferSelect;
export type MessengerMessageRow = typeof messengerMessages.$inferSelect;
