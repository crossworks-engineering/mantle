-- The answer cache (docs/provider-http.md, "Kept answers"; owner decision
-- 2026-11-20): every paid AI answer of queue work (a vision call, a Scan
-- reader page read, the extractor's call) is kept here by a hash of what was
-- asked, before anything after it can wait. A try again after a provider's
-- "not now" takes the kept answer, so it never pays for it twice, and a wait
-- is only a wait: nothing is counted.
--
-- Keyed by the node the answer was paid for and sha256 of (the kind, the
-- provider and model, the prompt, the input's bytes hash or name), hex, 64
-- chars: a try again of that node never pays twice, and another node with
-- the same bytes pays once for its own. An answer never outlives its file:
-- `node_id` cascades on the node's delete. The primary key leads with
-- `node_id`, so it is the index the cascade reads.
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
  "node_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "kind" text NOT NULL,
  "answer" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_answer_cache_pkey" PRIMARY KEY ("node_id", "key"),
  CONSTRAINT "ai_answer_cache_key_ck" CHECK ("key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_answer_cache_kind_ck" CHECK ("kind" ~ '^[a-z][a-z_]{0,39}$')
);
