import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';

export const traceKind = pgEnum('trace_kind', [
  'responder_turn',
  'extractor_run',
  'summarizer_run',
  'reflector_run',
  'photo_ingest',
  // Every data-entry moment opens one of these. The trace's
  // subject_id points at the resulting node so the node-biography
  // view can answer "where did this come from?" — see
  // recordIngest() in @mantle/tracing.
  'content_ingest',
  'manual',
]);

// 'skipped' is for pipelines that consciously decline to run (e.g.
// extractor finds the node already has a summary + embedding). The
// distinction from 'success' matters operationally: success means
// "I did the work"; skipped means "I considered the work and chose
// not to." Filtering /traces?status=skipped surfaces the silent
// no-ops we previously had no record of.
export const traceStatus = pgEnum('trace_status', [
  'running',
  'success',
  'error',
  'skipped',
]);

/**
 * One row per meaningful unit of work running in the agent process.
 * Token + cost aggregates live here so list views and dashboards don't
 * have to sum over potentially-hundreds of trace_steps.
 */
export const traces = pgTable(
  'traces',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    kind: traceKind('kind').notNull(),
    subjectId: uuid('subject_id'),
    /** 'telegram_message' | 'node' | 'chat' | 'agent_tick' | ... */
    subjectKind: text('subject_kind'),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    status: traceStatus('status').default('running').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    /** Total LLM cost in micro-USD (1e6 per USD). Integer math; safe to sum. */
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).default(0).notNull(),
    tokensIn: integer('tokens_in').default(0).notNull(),
    tokensOut: integer('tokens_out').default(0).notNull(),
    tokensCacheRead: integer('tokens_cache_read').default(0).notNull(),
    stepCount: integer('step_count').default(0).notNull(),
    error: text('error'),
    data: jsonb('data').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('traces_owner_kind_started_idx').on(t.ownerId, t.kind, t.startedAt),
    // Partial indexes (status='error' / subject_kind+subject_id) emitted by SQL migration.
  ],
);

export type Trace = typeof traces.$inferSelect;
export type NewTrace = typeof traces.$inferInsert;
