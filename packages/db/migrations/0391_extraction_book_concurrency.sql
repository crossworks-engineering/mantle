-- The book lane's setting (docs/embeddings.md, the lanes): how many books
-- extract at once in `mantle.extract.book`, beside "extractions at once"
-- (extraction_concurrency, 0099). Null: the EXTRACT_BOOK_CONCURRENCY env
-- value, then 1. The extractor reads it live in its 30 s reconcile
-- (server/api/src/agent/extract-queue.ts), as it reads the other lane
-- settings; PATCH /api/embedding/extraction and the MCP tool
-- extraction_set write it.
--
-- Range 1 to 4, the env value's own range (packages/config numbers.ts),
-- held here by a CHECK as well as by the route and the tool: a book is a
-- long run of parser jobs and the parser has one job slot, so more than 4
-- books at once only queue at the parser.
--
-- Not the narrow login's: the access matrix's update list for the table
-- is an allowlist and does not name the column, so a write runs at the
-- full-route spot model-route, as the other lane settings do.
--
-- Additive and re-runnable: an existing row reads null (the env value, as
-- before).
--
-- Rollback: packages/db/rollback/0391_extraction_book_concurrency.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
LOCK TABLE "public"."embedding_config" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."embedding_config" ADD COLUMN IF NOT EXISTS "extraction_book_concurrency" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'embedding_config_book_concurrency_ck'
  ) THEN
    ALTER TABLE "public"."embedding_config"
      ADD CONSTRAINT "embedding_config_book_concurrency_ck"
      CHECK ("extraction_book_concurrency" IS NULL OR "extraction_book_concurrency" BETWEEN 1 AND 4);
  END IF;
END $$;
