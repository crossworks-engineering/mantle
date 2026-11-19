-- Rollback of 0393_extraction_book_concurrency: what an operator MAY run
-- before pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional: the older image never reads the column (it takes the book
-- lane's count from EXTRACT_BOOK_CONCURRENCY only). This drops the column
-- and its check, so a saved book count is lost (set the env value to keep
-- it), and takes 0393 off the ledger, so the next roll forward applies it
-- again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0393_extraction_book_concurrency.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."embedding_config" DROP CONSTRAINT IF EXISTS "embedding_config_book_concurrency_ck";
--> statement-breakpoint
ALTER TABLE "public"."embedding_config" DROP COLUMN IF EXISTS "extraction_book_concurrency";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792320000000;
