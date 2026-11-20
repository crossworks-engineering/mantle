-- Fleet chat phase 1 (plan page f2f19c7b, sections 2 to 4): a group's
-- handle and its intake form.
--
--  - `handle`: an address for a group on this box, such as `bugs` (shown as
--    @bugs). Groups only. 2 to 30 characters: lowercase letters, digits and
--    dashes, no dash first or last. Unique among the live groups of the
--    box (one brain owns the rows of one box). A group admin sets or clears it, as the title. Every
--    login on the box may post to it: a message that names the handle
--    writes a copy line in the group (@mantle/content/messenger).
--  - `intake`: the form the group asks for, one of the three Send to IT
--    kinds (bug, feature, request), or null. The three forms are fixed in
--    @mantle/client-types/messenger-intake; there is no form editor.
--
-- The workspace role reads both columns (ACCESS_MATRIX lists them with the
-- other room columns). A change raises the room's `participants` event, as
-- a title change does: the trigger function is replaced with the two
-- columns added (CREATE OR REPLACE, the same signature).
--
-- No LLM work, no queue row, no cron: nothing here can start a turn. A
-- copy line is a system line; it starts no agent turn.
--
-- Rollback: packages/db/rollback/0394_messenger_handles.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- Every table this migration alters, in one statement before the first
-- change.
LOCK TABLE "public"."messenger_conversations" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

ALTER TABLE "public"."messenger_conversations"
  ADD COLUMN IF NOT EXISTS "handle" text;
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  ADD COLUMN IF NOT EXISTS "intake" text;
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  DROP CONSTRAINT IF EXISTS "messenger_conversations_handle_ck";
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  ADD CONSTRAINT "messenger_conversations_handle_ck" CHECK (
    "handle" IS NULL
    OR ("kind" = 'group' AND "handle" ~ '^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])$'));
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  DROP CONSTRAINT IF EXISTS "messenger_conversations_intake_ck";
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  ADD CONSTRAINT "messenger_conversations_intake_ck" CHECK (
    "intake" IS NULL
    OR ("kind" = 'group' AND "intake" IN ('bug', 'feature', 'request')));
--> statement-breakpoint
-- Unique among the live groups of the box: an archived group (its last
-- member left) keeps its handle as it was, and a new group may take it.
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_conversations_handle_uq"
  ON "messenger_conversations" ("owner_id", "handle")
  WHERE "handle" IS NOT NULL AND "archived_at" IS NULL;
--> statement-breakpoint

-- Only what a reader shows changes the room: the title, the picture, the
-- icon and colour, the info, the handle and intake, the workspace, the
-- agent, archived. A send's last_seq bump is the message's own event.
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_conversations_changed"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF new."title" IS DISTINCT FROM old."title"
     OR new."picture_attachment_id" IS DISTINCT FROM old."picture_attachment_id"
     OR new."icon" IS DISTINCT FROM old."icon"
     OR new."color" IS DISTINCT FROM old."color"
     OR new."info" IS DISTINCT FROM old."info"
     OR new."handle" IS DISTINCT FROM old."handle"
     OR new."intake" IS DISTINCT FROM old."intake"
     OR new."workspace_id" IS DISTINCT FROM old."workspace_id"
     OR new."agent_id" IS DISTINCT FROM old."agent_id"
     OR new."archived_at" IS DISTINCT FROM old."archived_at" THEN
    PERFORM pg_notify('messenger_changed', json_build_object('c', new."id", 'seq', NULL, 'kind', 'participants', 'actor', NULL)::text);
  END IF;
  RETURN NULL;
END
$$;
