-- Per-agent thinking effort (2026-10-03, docs/thinking.md).
--
-- NULL = inherit: the agent uses the person's profile setting ("Live thinking
-- & streaming"), exactly as before this column existed. 'off' = this agent
-- never asks for reasoning. A tier = this agent asks for that effort whatever
-- the profile says (the provider adapters drop or downgrade a tier a model
-- does not support).
--
-- Additive and nullable: every existing row reads NULL, so no agent changes
-- behaviour or spend. Plain DDL, no trigger, no job. Idempotent.
--
-- agents is a hot table: wait at most 30 s for the lock, then fail the roll
-- (migrations-lock-timeout.test.ts).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."agents" ADD COLUMN IF NOT EXISTS "thinking_effort" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_thinking_effort_check'
  ) THEN
    ALTER TABLE "public"."agents" ADD CONSTRAINT "agents_thinking_effort_check"
      CHECK ("thinking_effort" IS NULL
        OR "thinking_effort" IN ('off', 'low', 'medium', 'high', 'xhigh', 'max'));
  END IF;
END $$;
