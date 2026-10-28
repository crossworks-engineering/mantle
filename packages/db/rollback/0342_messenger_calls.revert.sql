-- Rollback of 0342_messenger_calls: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not
-- a migration: nothing runs it on its own.
--
-- Optional: the older image never reads the call tables, `event` or
-- `voice_replies`, and its migrate grants the workspace role the columns
-- its ACCESS_MATRIX names (not these). This drops the three call tables
-- (every call record is lost; the system lines in messenger_messages stay,
-- with their `event` column dropped), the two columns, and takes 0342 off
-- the ledger, so the next roll forward applies it again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0342_messenger_calls.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."messenger_call_webhooks";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."messenger_call_participants";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."messenger_calls";
--> statement-breakpoint
LOCK TABLE "public"."messenger_messages", "public"."messenger_conversations" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."messenger_messages" DROP CONSTRAINT IF EXISTS "messenger_messages_event_ck";
--> statement-breakpoint
ALTER TABLE "public"."messenger_messages" DROP COLUMN IF EXISTS "event";
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations" DROP COLUMN IF EXISTS "voice_replies";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200680000;
