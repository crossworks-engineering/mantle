-- Rollback of 0316_structure_item_definer: what an operator runs BEFORE
-- pinning an image older than the one that added it, if they want the
-- function gone. Not a migration: nothing runs it on its own.
--
-- 0316 adds one function, mantle_structure_item, and changes nothing else.
-- No older image calls it, so a rollback of one image or more needs NOT
-- this file: the function sits unused. This file drops it and takes 0316
-- off the ledger, so a later roll forward applies it again (it is
-- re-runnable).
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0316_structure_item_definer.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_structure_item"(text, text, uuid, uuid, uuid[], jsonb);
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0316 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790199040000;
