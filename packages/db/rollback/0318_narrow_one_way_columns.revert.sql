-- Rollback of 0318_narrow_one_way_columns: what an operator runs BEFORE
-- pinning an image older than the one that added it, if they want the
-- triggers gone. Not a migration: nothing runs it on its own.
--
-- 0318 adds one trigger function and a BEFORE UPDATE trigger on nine
-- tables; it refuses only the narrow system role, which an older image's
-- product writes never meet in the refused direction. An older image runs
-- with them in place: a rollback of one image needs NOT this file. This
-- file drops them and takes 0318 off the ledger, so a later roll forward
-- applies it again (it is re-runnable).
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0318_narrow_one_way_columns.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "auth"."users";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."access_keys";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."oauth_access_tokens";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."mobile_tokens";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."member_invites";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."peer_shares";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."peer_share_scopes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."mantle_peers";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."agents";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_one_way"();
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0318 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198400000;
