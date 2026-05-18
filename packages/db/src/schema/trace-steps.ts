import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { traces } from './traces';

export const traceStepKind = pgEnum('trace_step_kind', [
  'db_read',
  'db_write',
  'llm_call',
  'embed',
  'http',
  'notify',
  'compute',
  'send',
]);

export const traceStepStatus = pgEnum('trace_step_status', [
  'running',
  'success',
  'error',
  'skipped',
]);

/**
 * One row per discrete operation inside a trace. Nests via parent_step_id
 * (an extractor's per-fact loop becomes ~N children of a 'process_facts'
 * step). `ordinal` preserves order within the same parent. Truncated
 * input/output keeps row size bounded.
 */
export const traceSteps = pgTable(
  'trace_steps',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    traceId: uuid('trace_id')
      .notNull()
      .references(() => traces.id, { onDelete: 'cascade' }),
    parentStepId: uuid('parent_step_id'),
    ordinal: integer('ordinal').notNull(),
    name: text('name').notNull(),
    kind: traceStepKind('kind').notNull(),
    status: traceStepStatus('status').default('running').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    input: jsonb('input').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    output: jsonb('output').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('trace_steps_trace_idx').on(t.traceId, t.ordinal),
    index('trace_steps_parent_idx').on(t.parentStepId),
  ],
);

export type TraceStep = typeof traceSteps.$inferSelect;
export type NewTraceStep = typeof traceSteps.$inferInsert;
