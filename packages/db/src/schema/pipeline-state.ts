import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';

/**
 * The state of a pipeline on this box (migration 0373;
 * docs/pipelines-options.md): only what a box changed. No row means the
 * defaults of the code (defaultState, packages/files/src/pipelines/builtin.ts).
 *
 * ONE reader and ONE writer: packages/content/src/pipeline-state.ts
 * (pipelineStateOf, setPipelineState). Import this table nowhere else.
 * `options` is read only through effectiveOptions there, so a stored value
 * that no longer passes its spec gives the default; it is written only
 * after checkOptions.
 *
 * `enabled` and `workspaces`: NULL is the default of the code. They are for
 * an `after` pipeline only; a reader is on in every workspace.
 * `position`: NULL is the order of the code. Nothing writes it in phase 2,
 * by choice: each file type has one reader, so there is nothing to rank.
 *
 * Written by an Admin user with the settings area, read on the system pool.
 */
export const pipelineState = pgTable(
  'pipeline_state',
  {
    ownerId: uuid('owner_id').notNull(),
    pipelineId: text('pipeline_id').notNull(),
    enabled: boolean('enabled'),
    position: integer('position'),
    options: jsonb('options')
      .notNull()
      .default(sql`'{}'::jsonb`),
    workspaces: uuid('workspaces').array(),
    updatedBy: uuid('updated_by').references(() => authUsers.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.pipelineId] })],
);

export type PipelineStateRow = typeof pipelineState.$inferSelect;
