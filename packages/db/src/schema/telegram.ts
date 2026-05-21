import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { nodes } from './nodes';
import { agents } from './agents';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const telegramChatType = pgEnum('telegram_chat_type', ['private', 'group', 'supergroup']);

/**
 * `allowed` — messages from this chat are ingested.
 * `pending` — chat asked for a pairing code; we replied with one; user has not yet approved.
 * `denied`  — user explicitly blocked; silently drop.
 */
export const telegramAllowlistStatus = pgEnum('telegram_allowlist_status', [
  'allowed',
  'pending',
  'denied',
]);

/**
 * `inbound`  — DMs received from the user; trigger pg_notify.
 * `outbound` — replies emitted by an agent; persisted so the agent can see its
 *              own prior turns when assembling conversation history.
 */
export const telegramDirection = pgEnum('telegram_direction', ['inbound', 'outbound']);

export const telegramAccounts = pgTable(
  'telegram_accounts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    botUsername: text('bot_username').notNull(),
    /** Bot token, AES-GCM-encrypted with MANTLE_MASTER_KEY. */
    botTokenEnc: bytea('bot_token_enc').notNull(),
    /** ltree branch under which telegram messages get hung. */
    branchPath: text('branch_path').notNull(),
    /** Next getUpdates offset. Telegram caps at int32 but we use bigint for safety. */
    lastUpdateOffset: bigint('last_update_offset', { mode: 'number' }).default(0).notNull(),
    lastPollAt: timestamp('last_poll_at', { withTimezone: true }),
    lastPollError: text('last_poll_error'),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('telegram_accounts_user_idx').on(t.userId),
    uniqueIndex('telegram_accounts_user_bot_uq').on(t.userId, t.botUsername),
  ],
);

export const telegramChats = pgTable(
  'telegram_chats',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => telegramAccounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    /** Telegram's chat_id (their long int, stored as text to avoid overflow). */
    telegramChatId: text('telegram_chat_id').notNull(),
    chatType: telegramChatType('chat_type').notNull(),
    title: text('title'),
    username: text('username'),
    allowlistStatus: telegramAllowlistStatus('allowlist_status').default('pending').notNull(),
    /** Active pairing code, if any. Cleared when allowlistStatus flips to 'allowed' or expires. */
    pairingCode: text('pairing_code'),
    pairingExpiresAt: timestamp('pairing_expires_at', { withTimezone: true }),
    pairingReplies: integer('pairing_replies').default(0).notNull(),
    /** Per-chat override of which responder agent handles this chat. NULL =
     *  fall back to global priority resolution (highest-priority enabled
     *  responder). Cleared automatically if the referenced agent is deleted. */
    responderAgentId: uuid('responder_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('telegram_chats_account_idx').on(t.accountId),
    uniqueIndex('telegram_chats_account_telegram_id_uq').on(t.accountId, t.telegramChatId),
    index('telegram_chats_pairing_code_idx').on(t.pairingCode),
  ],
);

/**
 * One row per Telegram message we receive. Mirrors `emails` — every message
 * gets a backing `nodes` row of type 'telegram_message' so it participates
 * in tree/search/embedding, with the specifics living here.
 */
export const telegramMessages = pgTable(
  'telegram_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => telegramAccounts.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => telegramChats.id, { onDelete: 'cascade' }),
    /** Telegram's message_id within the chat. Null on outbound replies that
     *  were generated + saved but failed to send (undelivered, recoverable). */
    telegramMessageId: text('telegram_message_id'),
    /** Telegram's update_id — globally unique per bot, used for dedup + ack.
     * Inbound rows have this; outbound rows leave it null. */
    telegramUpdateId: bigint('telegram_update_id', { mode: 'number' }),
    /** Inbound rows only; outbound replies leave these null. */
    fromUserId: text('from_user_id'),
    fromUsername: text('from_username'),
    fromName: text('from_name'),
    text: text('text').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    /** Array of { kind, file_id, name?, mime?, size? } for documents/photos/voice/etc. */
    attachments: jsonb('attachments').$type<TelegramAttachment[]>().default(sql`'[]'::jsonb`).notNull(),
    /** True once Claude (or any client) has responded / acknowledged this message. */
    processed: boolean('processed').default(false).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** inbound = received DM; outbound = reply emitted by an agent. */
    direction: telegramDirection('direction').default('inbound').notNull(),
    /** Outbound provenance: which agent produced this reply, on which model,
     * and which inbound message it was replying to. Null for inbound rows. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    modelUsed: text('model_used'),
    replyToId: uuid('reply_to_id'),
    /** Outbound delivery state. False = the reply was generated + persisted but
     *  the Telegram send failed, so it never reached the user (recoverable /
     *  retry-able). Inbound + successfully-sent rows are true. */
    delivered: boolean('delivered').default(true).notNull(),
    /** Once this row is folded into a Tier-2 digest, points at the `note` node
     * that represents the digest. NULL = not yet summarized. */
    digestNodeId: uuid('digest_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Dedupe — Telegram occasionally retransmits an update.
    // Partial unique: outbound rows have null telegram_update_id.
    uniqueIndex('telegram_messages_account_update_uq')
      .on(t.accountId, t.telegramUpdateId)
      .where(sql`${t.telegramUpdateId} is not null`),
    index('telegram_messages_chat_idx').on(t.chatId),
    index('telegram_messages_node_idx').on(t.nodeId),
    index('telegram_messages_processed_idx').on(t.processed),
    index('telegram_messages_sent_at_idx').on(t.sentAt),
    index('telegram_messages_chat_sent_idx').on(t.chatId, t.sentAt),
  ],
);

export type TelegramAttachment = {
  kind: 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note' | 'sticker';
  file_id: string;
  name?: string;
  mime?: string;
  size?: number;
};

export type TelegramAccount = typeof telegramAccounts.$inferSelect;
export type NewTelegramAccount = typeof telegramAccounts.$inferInsert;
export type TelegramChat = typeof telegramChats.$inferSelect;
export type NewTelegramChat = typeof telegramChats.$inferInsert;
export type TelegramMessage = typeof telegramMessages.$inferSelect;
export type NewTelegramMessage = typeof telegramMessages.$inferInsert;
