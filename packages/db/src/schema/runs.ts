import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Runner queues — durable, inspectable execution plans (docs/runs.md, when it
 * lands; design: "Runner queues & worker agents — implementation plan v1").
 *
 * A **run** is one delegated goal: a tree of **run items** (structured
 * concurrency — `group_seq` / `group_par` groups, leaves are tool calls,
 * worker invocations, audits, human questions, notes). The tree IS the audit
 * log: items are immutable once created (`payload` never changes); re-planning
 * supersedes + appends. The responder suspends while items execute and is
 * resumed exactly once per attention-worthy group completion — guaranteed by
 * an atomic `children_done` counter on the group row (the row lock serializes
 * concurrent child completions; exactly one transaction observes
 * done == total), with pg-boss `singletonKey` as backstop and the deadline
 * sweep as the eventual-progress guarantee.
 *
 * Agent / turn references are SOFT uuids (no FK): run history is an audit
 * record and must survive agent deletion intact — the 0127 lesson
 * (delete-preserves-history), taken one step further: we keep the id, not a
 * NULL. `runs.owner_id` + `runs.agent_id` identify the conversation the run
 * belongs to (conversations are per (owner, agent) — there is no
 * conversations table; see assistant-messages.ts).
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    /** Responder agent whose conversation this run belongs to (and who
     *  created it). Soft ref to agents.id — survives agent deletion. */
    agentId: uuid('agent_id'),
    /** Soft ref to traces.id (kind 'responder_turn') — the turn that planned
     *  this run. */
    originTurnId: uuid('origin_turn_id'),
    /** Root group item. Set right after the root insert (circular otherwise). */
    rootItemId: uuid('root_item_id'),
    title: text('title').notNull(),
    /** 'running' | 'paused' | 'done' | 'failed' | 'cancelled' — CHECK in the
     *  migration (0132 added 'paused'). 'paused' is entered ONLY by the
     *  budget CAS; finalize/cancel CAS from ('running','paused'). */
    status: text('status').notNull().default('running'),
    /** Auto-pause budget in micro-USD (1e6 per USD; integer math like
     *  traces.cost_micro_usd). NULL = no budget. Enforced since slice 3 WP4:
     *  crossing it pauses the run (status CAS under the run lock) and queues
     *  a "raise or cancel?" pending row. */
    budgetMicroUsd: bigint('budget_micro_usd', { mode: 'number' }),
    /** Micro-USD actually spent — accumulated by completeItem under the run
     *  row lock (race-free by the lockRunRow rule; failed items count too —
     *  cost honesty). */
    spentMicroUsd: bigint('spent_micro_usd', { mode: 'number' }).notNull().default(0),
    /** When the budget pause landed; resume shifts READY audit/ask_human
     *  deadlines by the paused duration (running items keep their clocks). */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Runaway-append backstop — createRun/appendChildren refuse past it
     *  with a teaching error (slice 3 WP4). */
    itemCap: integer('item_cap').notNull().default(200),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('runs_owner_status_idx').on(t.ownerId, t.status),
    index('runs_created_idx').on(t.createdAt.desc()),
  ],
);

/** Item kinds. Groups are interior nodes; the rest are leaves. The full v1
 *  vocabulary ships in the CHECK from day one; the slice-1 dispatcher only
 *  executes 'tool_call' and 'note'. */
export type RunItemKind =
  | 'group_seq'
  | 'group_par'
  | 'tool_call'
  | 'worker_invoke'
  | 'audit'
  | 'ask_human'
  | 'note';

/** queued → ready → running → done | failed | cancelled | superseded.
 *  The last four are terminal; every terminal transition of a child drives
 *  its parent group's completion counter exactly once. */
export type RunItemState =
  | 'queued'
  | 'ready'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'superseded';

/** Structured failure record — never raw error text into a prompt. */
export type RunItemFailure = {
  type: string; // 'timeout' | 'tool_error' | 'cancelled' | ...
  message: string;
  itemId?: string;
};

export const runItems = pgTable(
  'run_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Parent group. Self-FK enforced in the SQL migration (nodes.ts idiom):
     *  ON DELETE CASCADE — deleting a group deletes its subtree, and the
     *  runs→run_items cascade stays order-safe on this self-referencing table. */
    parentId: uuid('parent_id'),
    /** Order within the parent (drives group_seq execution order). */
    position: integer('position').notNull().default(0),
    /** RunItemKind — CHECK in the migration. */
    kind: text('kind').$type<RunItemKind>().notNull(),
    /** RunItemState — CHECK in the migration. */
    state: text('state').$type<RunItemState>().notNull().default('queued'),
    // ── groups ──
    /** 'wait_all' (default; failures are terminal states, group completes with
     *  a summary) | 'fail_fast' (first failure cancels siblings). NULL on
     *  leaves. CHECK in the migration. */
    joinPolicy: text('join_policy'),
    childrenTotal: integer('children_total').notNull().default(0),
    /** The resume-storm solution: incremented atomically under the group's row
     *  lock on every child terminal transition. Exactly one transaction
     *  observes children_done == children_total and completes the group. */
    childrenDone: integer('children_done').notNull().default(0),
    /** Sealed at terminal transition — run_append to a sealed group errors
     *  (caller starts a new group). Open while running. */
    sealed: boolean('sealed').notNull().default(false),
    // ── execution ──
    /** Side-effecting items NEVER auto-retry (transport retryLimit 0 AND no
     *  semantic retry) — failure spawns an audit / ask_human item instead. */
    sideEffecting: boolean('side_effecting').notNull().default(false),
    /** Semantic retry policy ({ maxAttempts?: number }) — distinct from
     *  pg-boss transport retries. NULL = no semantic retry. */
    retryPolicy: jsonb('retry_policy').$type<{ maxAttempts?: number }>(),
    attempt: integer('attempt').notNull().default(0),
    /** Overdue running/ready items are failed(timeout) by the sweep — which
     *  drives the completion counter like any other terminal transition. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    /** IMMUTABLE once created (append-and-supersede; the queue is the audit
     *  log). Tool name+args | worker envelope | audit scope | note text. */
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Structured outcome, incl. `failure: RunItemFailure` on failed items. */
    result: jsonb('result').$type<Record<string, unknown> & { failure?: RunItemFailure }>(),
    /** Node ids: worker evidence, audit findings. */
    evidenceRefs: uuid('evidence_refs').array(),
    /** Soft ref to traces.id / assistant_messages.id — the execution trace. */
    traceRef: uuid('trace_ref'),
    /** Self-FK enforced in the SQL migration: ON DELETE SET NULL. */
    supersededBy: uuid('superseded_by'),
    // ── accounting (every item, unconditionally, at its own model's rate) ──
    /** Soft ref to agents.id (executing agent — worker or responder). */
    agentId: uuid('agent_id'),
    model: text('model'),
    usage: jsonb('usage').$type<Record<string, number>>(),
    /** Micro-USD (1e6 per USD), integer math — same unit as traces. */
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Resume idempotency marker (migration 0130) — set once, by CAS, when a
     *  resume-worthy group's responder wake-up is claimed (claimResume). NULL
     *  on everything else. At-most-once: marked BEFORE the resume turn runs. */
    resumedAt: timestamp('resumed_at', { withTimezone: true }),
  },
  (t) => [
    index('run_items_run_state_idx').on(t.runId, t.state),
    index('run_items_parent_idx').on(t.parentId, t.position),
    // Sweep partial index lives in the migration (drizzle table builders don't
    // express partial indexes; see 0129).
  ],
);

export type RunRow = typeof runs.$inferSelect;
export type RunItemRow = typeof runItems.$inferSelect;
