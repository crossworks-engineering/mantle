-- A trace keeps its embedding input tokens apart from its completion tokens
-- (A10 #5, docs/spend-recording.md). tokens_in and tokens_out are what a
-- completion (chat, stream, decision, vision, research) took and gave; the
-- member token budget (@mantle/content member-turn-ledger.ts) reads those.
-- An embedding call's input tokens land here instead, so a turn that embeds
-- a large spilled result never moves a member's budget. The rollups show it
-- as its own number.
--
-- One integer column with a constant default: no table rewrite, no backfill
-- (a trace closed before this migration recorded no embedding tokens), no
-- trigger, no LLM work. The lock is taken first and never waited for past
-- 30 s behind live traffic (as 0283). Re-runnable: ADD IF NOT EXISTS.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."traces"
  ADD COLUMN IF NOT EXISTS "tokens_embed" integer DEFAULT 0 NOT NULL;
