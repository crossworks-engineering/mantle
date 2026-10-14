-- A call queued for approval says when it runs with more rights than the
-- turn that asked for it (workspaces arch A5 step 6d, owner decision 1a):
-- a member turn may be offered a connector write it cannot make itself (the
-- connector's Write is off in its workspace, or it is not a Moderator there)
-- only when the call waits for approval anyway (a requires_confirm tool, or
-- a client-sourced turn), and the approver runs it with Admin rights. The
-- server sets the column at queue time (packages/runtime tool-loop
-- execute-call.ts, from turnCallRefusal's `queue`): {"elevated": true,
-- "reason": "..."}; NULL for every other call. The approval card shows it.
--
-- One nullable column with no default: no table rewrite, no backfill, no
-- trigger, no LLM work. The lock is taken first and never waited for past
-- 30 s behind live traffic (as 0283). Re-runnable: ADD IF NOT EXISTS.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."pending_tool_calls"
  ADD COLUMN IF NOT EXISTS "elevated" jsonb;
