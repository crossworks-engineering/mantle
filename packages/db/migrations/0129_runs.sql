-- Runner queues — durable, inspectable execution plans (slice 1: the spine).
-- Design: "Runner queues & worker agents — implementation plan v1" (§4).
--
-- A run is one delegated goal: a tree of run items (structured concurrency —
-- group_seq / group_par interior nodes; tool_call / worker_invoke / audit /
-- ask_human / note leaves). Items are IMMUTABLE once created (payload never
-- updated; re-planning supersedes + appends) — the queue is the audit log.
--
-- Resume-storm solution (DECIDED 2026-07-21): completion is one atomic
-- counter on the group row. Every child terminal transition does
--   UPDATE run_items SET children_done = children_done + 1 WHERE id = :parent
--   RETURNING children_done, children_total
-- under the group's row lock, so concurrent child completions serialize and
-- exactly ONE transaction observes done == total, transitions the group, and
-- bubbles to ITS parent (recursion up the tree). pg-boss singletonKey
-- backstops the resume enqueue; the deadline sweep guarantees progress.
--
-- Soft refs by design (no FK): runs.agent_id / runs.origin_turn_id /
-- run_items.agent_id / run_items.trace_ref. Run history is an audit record
-- and survives agent/trace deletion with ids intact (0127's
-- delete-preserves-history, one step further — keep the id, not a NULL).
-- There is no conversations table — a conversation is (owner_id, agent_id);
-- see assistant_messages (0072).
--
-- Costs are integer micro-USD (1e6 per USD), same unit as traces.

CREATE TABLE IF NOT EXISTS "runs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"        uuid NOT NULL,
  "agent_id"        uuid,
  "origin_turn_id"  uuid,
  "root_item_id"    uuid,
  "title"           text NOT NULL,
  "status"          text NOT NULL DEFAULT 'running'
                    CHECK ("status" IN ('running', 'done', 'failed', 'cancelled')),
  "budget_micro_usd" bigint,
  "item_cap"        integer NOT NULL DEFAULT 200,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  "completed_at"    timestamptz
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "run_items" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id"          uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  -- CASCADE keeps the runs→run_items cascade order-safe on a self-referencing
  -- table, and "delete a group deletes its subtree" is the semantics we want.
  "parent_id"       uuid REFERENCES "run_items"("id") ON DELETE CASCADE,
  "position"        integer NOT NULL DEFAULT 0,
  "kind"            text NOT NULL
                    CHECK ("kind" IN ('group_seq', 'group_par', 'tool_call',
                                      'worker_invoke', 'audit', 'ask_human', 'note')),
  "state"           text NOT NULL DEFAULT 'queued'
                    CHECK ("state" IN ('queued', 'ready', 'running',
                                       'done', 'failed', 'cancelled', 'superseded')),
  -- groups
  "join_policy"     text CHECK ("join_policy" IS NULL OR "join_policy" IN ('wait_all', 'fail_fast')),
  "children_total"  integer NOT NULL DEFAULT 0,
  "children_done"   integer NOT NULL DEFAULT 0,
  "sealed"          boolean NOT NULL DEFAULT false,
  -- execution
  "side_effecting"  boolean NOT NULL DEFAULT false,
  "retry_policy"    jsonb,
  "attempt"         integer NOT NULL DEFAULT 0,
  "deadline_at"     timestamptz,
  "payload"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result"          jsonb,
  "evidence_refs"   uuid[],
  "trace_ref"       uuid,
  "superseded_by"   uuid REFERENCES "run_items"("id") ON DELETE SET NULL,
  -- accounting
  "agent_id"        uuid,
  "model"           text,
  "usage"           jsonb,
  "cost_micro_usd"  bigint,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  "started_at"      timestamptz,
  "finished_at"     timestamptz
);--> statement-breakpoint

-- Dispatcher walks (run_id, state); tree render walks (parent_id, position).
CREATE INDEX IF NOT EXISTS "run_items_run_state_idx" ON "run_items" ("run_id", "state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_items_parent_idx" ON "run_items" ("parent_id", "position");--> statement-breakpoint
-- Deadline sweep: only non-terminal items can be overdue.
CREATE INDEX IF NOT EXISTS "run_items_sweep_idx" ON "run_items" ("deadline_at")
  WHERE "state" IN ('queued', 'ready', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_owner_status_idx" ON "runs" ("owner_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_created_idx" ON "runs" ("created_at" DESC);
