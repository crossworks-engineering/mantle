-- Rollback of 0326_member_turn_ledger_definers: what an operator runs BEFORE
-- pinning an image older than the one that added it, if they want its
-- functions gone. Not a migration: nothing runs it on its own.
--
-- An older image writes member_turn_ledger itself on the system pool; its
-- own migrate grants the runtime role those writes again (0326's image took
-- them through access-matrix.ts, not through this migration), so the older
-- image runs with or without this revert. Order when reverting several:
-- 0327 first, then 0326, 0325, 0324, 0323, 0322, 0321, then 0320 down to
-- 0315, each in its own transaction, newest first.
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0326_member_turn_ledger_definers.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_member_turn_claim"(text, uuid, timestamptz, integer, bigint);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_member_turn_release"(text);
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0326 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790199640000;
