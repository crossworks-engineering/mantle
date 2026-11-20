-- The answer cache (docs/provider-http.md, "Kept answers"; owner decision
-- 2026-11-20): every paid AI answer of queue work (a vision call, a Scan
-- reader page read, the extractor's call) is kept here by a hash of what was
-- asked, before anything after it can wait. A try again after a provider's
-- "not now" takes the kept answer, so it never pays for it twice, and a wait
-- is only a wait: nothing is counted.
--
-- Keyed by sha256 of (the kind, the provider and model, the prompt, the
-- input's bytes hash or name), hex, 64 chars, as embedding_cache (0014).
-- `answer`: the provider's answer and its cost metadata (tokens, billed
-- cost), as the caller rebuilds its result from it. A person's read again
-- (file_reindex) takes only answers kept after it (`created_at`).
--
-- Written and read on the system pool only (@mantle/db answer-cache.ts),
-- outside every scope: the workspace role holds no right on it
-- (access-matrix.ts, as embedding_cache). Additive, no rewrite, no LLM work.
-- Re-runnable. Revert: packages/db/rollback/0392_ai_answer_cache.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ai_answer_cache" (
  "key" text PRIMARY KEY,
  "kind" text NOT NULL,
  "answer" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_answer_cache_key_ck" CHECK ("key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_answer_cache_kind_ck" CHECK ("kind" ~ '^[a-z][a-z_]{0,39}$')
);
