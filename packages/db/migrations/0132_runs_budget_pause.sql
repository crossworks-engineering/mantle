-- 0132 — runner queues slice 3 WP4: budget / item-cap auto-pause
-- (docs/runs-slice-3-plan.md §4 WP4 + audit amendments).
--
-- spent_micro_usd: integer micro-USD accumulated by completeItem UNDER THE
-- RUN ROW LOCK (the audit's lockRunRow rule makes it race-free — plan C5).
-- paused_at: stamped by the budget-pause CAS; used at resume to shift
-- READY audit/ask_human deadlines by the paused duration (nothing was
-- executing — running items keep their clocks, amendment 3).
-- status gains 'paused': entered ONLY by the budget CAS (running → paused);
-- left by the budget approval (paused → running) or run_cancel / the final
-- completion, whose CASes accept ('running','paused') — amendment 2.

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "spent_micro_usd" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "paused_at" timestamptz;--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_status_check";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("status" IN ('running', 'paused', 'done', 'failed', 'cancelled'));
