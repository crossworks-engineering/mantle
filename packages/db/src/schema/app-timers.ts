import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';
import { nodes } from './nodes';

/**
 * App timers (migration 0355; docs/app-timers.md): one declared, read-only
 * tool of a mini app called on a clock, with no model and no person per
 * run. The scheduler (the maintenance worker) runs each due timer as the
 * login that set it (`createdBy`), through the app's own tool rules, and
 * appends one row per run to the app's own SQLite database
 * (`_timer_runs`).
 *
 * `lastError` is a fixed short text (APP_TIMER_ERRORS in @mantle/tools),
 * never a caught error's. `claimId` and `claimedAt` hold the run in flight:
 * a tick claims a due row with FOR UPDATE SKIP LOCKED and only the claim's
 * holder writes its outcome. The caps (5 per app, 100 per box) are the
 * database's (mantle_app_timers_cap). Read and written with manage of the
 * app (the row rule and the write check); goes with its app.
 */
export const appTimers = pgTable(
  'app_timers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    appNodeId: uuid('app_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    toolSlug: text('tool_slug').notNull(),
    args: jsonb('args')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    everyMinutes: integer('every_minutes').notNull().default(5),
    keepDays: integer('keep_days').notNull().default(90),
    enabled: boolean('enabled').notNull().default(true),
    /** The login the timer runs as: the last one that set it. NULL once
     *  that login is removed (the timer then fails closed). */
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).defaultNow().notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastOk: boolean('last_ok'),
    lastError: text('last_error'),
    lastMs: integer('last_ms'),
    failCount: integer('fail_count').notNull().default(0),
    claimId: uuid('claim_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('app_timers_app_name_uq').on(t.appNodeId, t.name),
    index('app_timers_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.enabled}`),
    index('app_timers_created_by_idx')
      .on(t.createdBy)
      .where(sql`${t.createdBy} IS NOT NULL`),
    index('app_timers_owner_idx').on(t.ownerId),
  ],
);

export type AppTimerRow = typeof appTimers.$inferSelect;
