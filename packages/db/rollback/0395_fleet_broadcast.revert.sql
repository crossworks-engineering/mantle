-- Rollback of 0395_fleet_broadcast: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional: the older image never reads or writes `announcements` or
-- control_broadcasts, and its migrate grants the workspace role the
-- columns its ACCESS_MATRIX names (not this one). This drops the index, the
-- check and the column (the Announcements group stays as a plain group with
-- no admin; its lines stay as system lines), drops control_broadcasts (the
-- CC's broadcasts and their marks are lost; the boxes keep their lines),
-- and takes 0395 off the ledger, so the next roll forward applies it again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0395_fleet_broadcast.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
LOCK TABLE "public"."messenger_conversations" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."messenger_conversations_announcements_uq";
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  DROP CONSTRAINT IF EXISTS "messenger_conversations_announcements_ck";
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations" DROP COLUMN IF EXISTS "announcements";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."control_broadcasts";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792340060000;
