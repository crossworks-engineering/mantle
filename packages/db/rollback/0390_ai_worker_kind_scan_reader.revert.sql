-- Rollback of 0390_ai_worker_kind_scan_reader: what an operator MAY run before
-- pinning the image one release back. Not a migration: nothing runs it on
-- its own.
--
-- `ALTER TYPE ... ADD VALUE` is not reversible (0202 says why), and nothing
-- has to be undone: an unused enum value costs nothing. A brain that seeded a
-- Scan reader worker keeps its row; the older image does not know the kind
-- and never resolves it, so the scanned pages take their old path. This
-- revert only takes 0390 off the ledger, so the next roll forward runs it
-- again (ADD VALUE IF NOT EXISTS: a no-op then).
--
--   docker exec mantle_web cat /app/packages/db/rollback/0390_ai_worker_kind_scan_reader.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792290000000;
