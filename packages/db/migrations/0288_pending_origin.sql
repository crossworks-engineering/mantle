-- A call queued for approval carries the scope it was asked in (workspaces
-- arch A5 step 6c, the approval re-check). The server sets the column at
-- queue time (@mantle/tools pending-origin.ts, from the tool loop's queue
-- path and the agent queue helpers), never from model arguments: the
-- asking turn's scope whole (its login, its workspaces, its Moderator
-- workspaces), how the turn entered it (a turn scope, or the rollback
-- switch's gate scope) and whether it wrote as an Admin turn, the Admin view
-- it had (whether it held Admin, and its Admin areas), and the surface it
-- ran on. At approval the call is judged again, and run, in that scope met
-- with the asker's rights as they are then: it never gains a right the
-- asker lost, and never runs wider than where it was asked
-- (@mantle/tools pending-approval.ts originApproval).
--
-- NULL for a row queued before this migration and for one no turn queued (a
-- run's question or budget pause, the dev console's test row): such a call
-- is approved by the rule it had before (the asker's current rights, in the
-- scope of the path that approves), named the legacy rule in docs/actors.md.
--
-- One nullable column with no default: no table rewrite, no backfill, no
-- trigger, no LLM work. The lock is taken first and never waited for past
-- 30 s behind live traffic (as 0283). Re-runnable: ADD IF NOT EXISTS.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."pending_tool_calls"
  ADD COLUMN IF NOT EXISTS "origin" jsonb;
