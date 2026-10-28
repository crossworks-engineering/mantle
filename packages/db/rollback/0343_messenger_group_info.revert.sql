-- Rollback of 0343_messenger_group_info: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional: the older image never reads or writes `info`, and its migrate
-- grants the workspace role the columns its ACCESS_MATRIX names (not this
-- one). This puts 0341's trigger function back, drops the check and the
-- column (a group's info text is lost), and takes 0343 off the ledger, so
-- the next roll forward applies it again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0343_messenger_group_info.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
LOCK TABLE "public"."messenger_conversations" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_conversations_changed"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF new."title" IS DISTINCT FROM old."title"
     OR new."picture_attachment_id" IS DISTINCT FROM old."picture_attachment_id"
     OR new."icon" IS DISTINCT FROM old."icon"
     OR new."color" IS DISTINCT FROM old."color"
     OR new."workspace_id" IS DISTINCT FROM old."workspace_id"
     OR new."agent_id" IS DISTINCT FROM old."agent_id"
     OR new."archived_at" IS DISTINCT FROM old."archived_at" THEN
    PERFORM pg_notify('messenger_changed', json_build_object('c', new."id", 'seq', NULL, 'kind', 'participants', 'actor', NULL)::text);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  DROP CONSTRAINT IF EXISTS "messenger_conversations_info_ck";
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  DROP COLUMN IF EXISTS "info";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200740000;
