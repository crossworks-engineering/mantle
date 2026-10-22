-- Rollback of 0316_promotion_agent_definers: what an operator runs BEFORE
-- pinning an image older than the one that added it, if they want the
-- functions gone. Not a migration: nothing runs it on its own.
--
-- 0316 adds two functions, mantle_space_settle_promotion and
-- mantle_agent_delete, and changes nothing else. No older image calls
-- them, so a rollback of one image or more needs NOT this file: the
-- functions sit unused. This file drops them and takes 0316 off the
-- ledger, so a later roll forward applies it again (it is re-runnable).
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0316_promotion_agent_definers.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_space_settle_promotion"(uuid, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_agent_delete"(uuid, uuid, uuid, boolean);
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0316 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198280000;
