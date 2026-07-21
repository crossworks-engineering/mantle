-- Runs slice 1, part 2 (the live engine around 0129's tables):
--
-- 1. run_items.resumed_at — the resume-turn idempotency marker. The resume
--    handler CASes it from NULL exactly once per resume-worthy group
--    (claimResume); duplicate resume jobs (pg-boss redelivery, the sweep
--    re-sending a lost job) find it set and ack without running a turn.
--    At-most-once by design: marked BEFORE the turn runs.
--
-- 2. trace_kind 'run_item' — one trace per dispatched run-item execution
--    (the dispatcher wraps tool_call handling in it; subject_kind='run_item',
--    subject_id = the run_items row). Kept out of 0129 so no migration adds
--    an enum value and uses it in the same file (migrate.ts replay rule);
--    only runtime code uses the value.

ALTER TABLE "run_items" ADD COLUMN IF NOT EXISTS "resumed_at" timestamptz;--> statement-breakpoint
ALTER TYPE "trace_kind" ADD VALUE IF NOT EXISTS 'run_item';
