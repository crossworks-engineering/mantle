import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { emailAccounts } from './emails';

/**
 * The curation layer. Every From address we've ever seen on a header lands
 * here; users approve the ones worth keeping. Bodies and attachments are
 * only ingested once a sender is `approved`.
 *
 * Domain-level decisions live in `email_sender_domains`. Conflict rule:
 * the per-address row wins over the domain row.
 */

export const senderStatus = pgEnum('sender_status', ['pending', 'approved', 'denied']);
export const senderDomainStatus = pgEnum('sender_domain_status', ['approved', 'denied']);

export const emailSenders = pgTable(
  'email_senders',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    /** First account that saw this sender. Decisions still apply across accounts. */
    sourceAccountId: uuid('source_account_id').references(() => emailAccounts.id, {
      onDelete: 'set null',
    }),
    /** Lowercased, e.g. "newsletter@printables.com". */
    address: text('address').notNull(),
    /** Lowercased, computed from the address. Indexed for domain queries. */
    domain: text('domain').notNull(),
    /** Best-effort display name from the most recent header. */
    displayName: text('display_name'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    messageCount: integer('message_count').default(0).notNull(),
    status: senderStatus('status').default('pending').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('email_senders_user_addr_uq').on(t.userId, t.address),
    index('email_senders_user_domain_idx').on(t.userId, t.domain),
    index('email_senders_user_status_idx').on(t.userId, t.status),
    index('email_senders_user_last_seen_idx').on(t.userId, t.lastSeenAt),
  ],
);

export const emailSenderDomains = pgTable(
  'email_sender_domains',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    /** Lowercased, e.g. "printables.com". */
    domain: text('domain').notNull(),
    status: senderDomainStatus('status').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('email_sender_domains_user_domain_uq').on(t.userId, t.domain)],
);

export type EmailSender = typeof emailSenders.$inferSelect;
export type NewEmailSender = typeof emailSenders.$inferInsert;
export type EmailSenderDomain = typeof emailSenderDomains.$inferSelect;
export type NewEmailSenderDomain = typeof emailSenderDomains.$inferInsert;
