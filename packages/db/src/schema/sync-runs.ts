import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { emailAccounts } from './emails';

/**
 * One row per sync worker invocation. Inserted at start (`status='running'`),
 * updated at the end with finish time + tallies. Used for "is sync alive?"
 * and "why did things go quiet?" without scraping the worker's stdout.
 */
export const syncStatus = pgEnum('sync_status', ['running', 'ok', 'error']);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => emailAccounts.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // Generated column on the DB side; declared here so SELECTs can read it.
    durationMs: integer('duration_ms'),
    status: syncStatus('status').default('running').notNull(),
    scanned: integer('scanned').default(0).notNull(),
    ingested: integer('ingested').default(0).notNull(),
    error: text('error'),
  },
  (t) => [index('sync_runs_account_started_idx').on(t.accountId, t.startedAt)],
);

export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;
