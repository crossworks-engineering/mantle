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

export const messengerConversations = pgTable('messenger_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),
  kind: text('kind').$type<'direct' | 'group'>().notNull(),
  title: text('title'),
  pictureAttachmentId: uuid('picture_attachment_id'),
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
});

export const messengerParticipants = pgTable('messenger_participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => messengerConversations.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'login' | 'agent'>().notNull(),
  loginId: uuid('login_id'),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  role: text('role').$type<'admin' | 'member'>().default('member').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  addedBy: uuid('added_by'),
  leftAt: timestamp('left_at', { withTimezone: true }),
  /** Set with left_at: the participant reads up to here and nothing after. */
  leftSeq: bigint('left_seq', { mode: 'number' }),
  lastReadSeq: bigint('last_read_seq', { mode: 'number' }).default(0).notNull(),
  mentionSeq: bigint('mention_seq', { mode: 'number' }).default(0).notNull(),
  clearedBeforeSeq: bigint('cleared_before_seq', { mode: 'number' }).default(0).notNull(),
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

export type MessengerConversationRow = typeof messengerConversations.$inferSelect;
export type MessengerParticipantRow = typeof messengerParticipants.$inferSelect;
export type MessengerMessageRow = typeof messengerMessages.$inferSelect;
