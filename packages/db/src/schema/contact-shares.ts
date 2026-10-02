import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';
import { shares } from './shares';

/**
 * A contact's sharing code (contact shares, migration 0214). One row per
 * contact that ever had sharing; sharing is on while `code_hash` is set.
 * `code_hash` is an HMAC keyed from MANTLE_MASTER_KEY, so a database copy
 * alone recovers no code. `code_epoch` only goes up (regenerate, switch
 * off): a visitor cookie names the epoch it was minted at, and an older one
 * never matches again. The failure counters live here, so a restart or a
 * second web process does not reset them. See docs/sharing.md.
 */
export const contactShareCodes = pgTable(
  'contact_share_codes',
  {
    contactId: uuid('contact_id')
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').notNull(),
    codeHash: text('code_hash'),
    codeEpoch: integer('code_epoch').default(1).notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    failedAttempts: integer('failed_attempts').default(0).notNull(),
    /** Start of the current day window of `failed_attempts`. */
    failedSince: timestamp('failed_since', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [index('contact_share_codes_owner_idx').on(t.ownerId)],
);

export type ContactShareCodeRow = typeof contactShareCodes.$inferSelect;

/** What a contact did on a contact share. */
export type ShareAccessKind =
  | 'open'
  | 'asset'
  | 'query'
  | 'write'
  // A contact's call of an outside tool with External access (migration 0225).
  | 'tool'
  | 'refused'
  | 'code_failed';

/**
 * The contact share audit trail (migration 0214): one row per open (at most
 * one a minute per share), asset, database call, refusal and failed code.
 * Reaped after 90 days by the app-access-log-reap sweep. Deleting a share
 * or a contact sets its id NULL (like app_access_log): the trail stays.
 */
export const shareAccessLog = pgTable(
  'share_access_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** NULL once the share is deleted (a deleted contact takes its shares):
     *  the trail stays. */
    shareId: uuid('share_id').references(() => shares.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'set null' }),
    kind: text('kind').$type<ShareAccessKind>().notNull(),
    detail: jsonb('detail')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('share_access_log_share_idx').on(t.shareId, t.createdAt.desc()),
    index('share_access_log_contact_idx').on(t.contactId, t.createdAt.desc()),
    index('share_access_log_created_idx').on(t.createdAt),
  ],
);

export type ShareAccessLogRow = typeof shareAccessLog.$inferSelect;
