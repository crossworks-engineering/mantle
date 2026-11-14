import { sql } from 'drizzle-orm';
import { bigint, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';

/**
 * The state of a pipeline on this box (migration 0373; docs/pipelines.md,
 * "Options and the state of a pipeline"): only what a box changed. No row
 * means the defaults of the code (defaultState,
 * packages/files/src/pipelines/builtin.ts).
 *
 * ONE reader and ONE writer: packages/content/src/pipeline-state.ts
 * (pipelineStateOf, setPipelineState). Import this table nowhere else.
 * `options` is read only through effectiveOptions there, so a stored value
 * that no longer passes its spec gives the default; it is written only
 * after checkOptions.
 *
 * `workspaces`: the attach list of an `after` pipeline. NULL is the default
 * of the code. Off is attached to no workspace. A reader is used in every
 * workspace and has no list.
 *
 * Never give this table a boolean column named `enabled`, `is_default` or
 * `backup_enabled`: two sweeps (narrow-rules-13b, narrow-rules-14) pick
 * columns by those names and demand a guard trigger on them.
 *
 * `runs` and `last_run_at`: how many times the pipeline wrote its result
 * into a file's database on this box, and when it last did
 * (countPipelineRun). Counters: no right, no spend. They never touch
 * `options`, `workspaces`, `updated_by` or `updated_at`, which say who
 * changed the settings last.
 *
 * Written by an Admin user with the settings area, read on the system pool.
 */
export const pipelineState = pgTable(
  'pipeline_state',
  {
    ownerId: uuid('owner_id').notNull(),
    pipelineId: text('pipeline_id').notNull(),
    options: jsonb('options')
      .notNull()
      .default(sql`'{}'::jsonb`),
    workspaces: uuid('workspaces').array(),
    updatedBy: uuid('updated_by').references(() => authUsers.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    runs: bigint('runs', { mode: 'number' }).notNull().default(0),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.pipelineId] })],
);
