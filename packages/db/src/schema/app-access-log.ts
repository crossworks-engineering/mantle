import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';
import { authUsers } from './auth-users';

/**
 * Audit trail for the EXTERNAL app-share surface (/s/<token>/*). One row per
 * visitor action against a shared mini-app: a successful team-token auth, a
 * brokered tool call, or a brokered db statement. Member and client logins
 * running an app land the same rows. Since the apps first-class plan (G4)
 * it also keeps `error` rows: the errors a broker answered a running app
 * with, whoever ran it, the OWNER included (content app-access-log.ts).
 *
 * `contact_id` is the team member the visitor authenticated as — NULL means an
 * anonymous public-mode visitor. SET NULL (not cascade) on contact deletion:
 * the history of "something happened" outlives the person's contact record.
 * `share_id` is informational (shares are soft-revoked, rows persist).
 * `actor_id` is the member LOGIN that ran the app from the member shell
 * (member logins Phase 4b, migration 0172); NULL on share-link rows.
 *
 * The owner's own successful broker calls (/api/apps/*) are NOT logged here:
 * apart from errors, this table answers "what did outsiders do", not "what
 * did I do".
 */
export const appAccessLog = pgTable(
  'app_access_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    appNodeId: uuid('app_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    shareId: uuid('share_id'),
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').references(() => authUsers.id, { onDelete: 'set null' }),
    /** 'auth' | 'tool' | 'db' | 'error' */
    kind: text('kind').notNull(),
    /** e.g. { slug } for tool calls, { op } for db statements. */
    detail: jsonb('detail')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('app_access_log_app_idx').on(t.appNodeId, t.createdAt.desc()),
    index('app_access_log_owner_idx').on(t.ownerId),
    index('app_access_log_contact_idx').on(t.contactId),
    index('app_access_log_actor_idx').on(t.actorId),
    // The retention reaper's range scan (migration 0218).
    index('app_access_log_created_idx').on(t.createdAt),
    // An app's errors (app_errors, the Activity tab, the reaper's per-app
    // cap) without reading its whole trail (migration 0224).
    index('app_access_log_error_idx')
      .on(t.appNodeId, t.createdAt.desc())
      .where(sql`${t.kind} = 'error'`),
  ],
);

export type AppAccessLogRow = typeof appAccessLog.$inferSelect;
