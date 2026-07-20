import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Unified maintenance run history (docs/maintenance-runner.md) — one row per
 * invocation of a maintenance-registry task from any surface: the CLI
 * (`pnpm maintain`), the /debug/integrity Maintenance tab, or the nightly
 * cron sweep. The cron scheduler also reads the latest 'cron' row per slug
 * as its double-fire guard. See migration 0128.
 */
export const maintenanceRuns = pgTable(
  'maintenance_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    /** 'cli' | 'ui' | 'cron' — enforced by a CHECK in the migration. */
    source: text('source').notNull(),
    live: boolean('live').notNull(),
    /** 'running' | 'done' | 'failed' | 'cancelled' — CHECK in the migration. */
    state: text('state').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    exitCode: integer('exit_code'),
    summary: text('summary'),
  },
  (t) => [
    index('maintenance_runs_slug_started_idx').on(t.slug, t.startedAt.desc()),
    index('maintenance_runs_started_idx').on(t.startedAt.desc()),
  ],
);

export type MaintenanceRunRow = typeof maintenanceRuns.$inferSelect;
