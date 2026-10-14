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
-- And when the turn that asked had read text a client wrote (plan N18: a
-- client-sourced turn, whose writes wait for approval), the row says so
-- (A5 step 6d fix round 1): {"via": "..."}, what marked the turn, so the
-- approver can tell a request they made from one a client's text led to.
-- NULL for a turn that read none.
--
-- Two nullable columns with no default: no table rewrite, no backfill, no
-- trigger, no LLM work. The lock is taken first and never waited for past
-- 30 s behind live traffic (as 0283). Re-runnable: ADD IF NOT EXISTS.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."pending_tool_calls"
  ADD COLUMN IF NOT EXISTS "elevated" jsonb;
--> statement-breakpoint
ALTER TABLE "public"."pending_tool_calls"
  ADD COLUMN IF NOT EXISTS "client_sourced" jsonb;
