-- A group's info (Messenger V1, plan page d8954876 section 24): free text
-- that says what the group is for and its rules, written by the group's
-- admins on the create and edit form, read by everyone in the group and by
-- the agents that open it (messenger_open). Text only: the brain stores
-- and shows it and never runs it; a brain agent in a group (Phase 3) gets
-- it in its prompt as the group's rules, under the same taint as any
-- member's text. Nullable; a direct chat has none and at most 2000
-- characters (the check).
--
-- The workspace role reads the column (ACCESS_MATRIX lists it with the
-- other room columns; migrate grants the named columns). A change raises
-- the room's `participants` event, as a title change does: the
-- conversations trigger function is replaced with the column added to
-- what a reader shows (CREATE OR REPLACE, the same signature).
--
-- No LLM work, no queue row, no cron: nothing here can start a turn.
--
-- Rollback: packages/db/rollback/0343_messenger_group_info.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- Every table this migration alters, in one statement before the first
-- change.
LOCK TABLE "public"."messenger_conversations" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

ALTER TABLE "public"."messenger_conversations"
  ADD COLUMN IF NOT EXISTS "info" text;
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  DROP CONSTRAINT IF EXISTS "messenger_conversations_info_ck";
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  ADD CONSTRAINT "messenger_conversations_info_ck" CHECK (
    ("info" IS NULL OR "kind" = 'group')
    AND ("info" IS NULL OR char_length("info") <= 2000));
--> statement-breakpoint

-- Only what a reader shows changes the room: the title, the picture, the
-- icon and colour, the info, the workspace, the agent, archived. A send's
-- last_seq bump is the message's own event.
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_conversations_changed"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF new."title" IS DISTINCT FROM old."title"
     OR new."picture_attachment_id" IS DISTINCT FROM old."picture_attachment_id"
     OR new."icon" IS DISTINCT FROM old."icon"
     OR new."color" IS DISTINCT FROM old."color"
     OR new."info" IS DISTINCT FROM old."info"
     OR new."workspace_id" IS DISTINCT FROM old."workspace_id"
     OR new."agent_id" IS DISTINCT FROM old."agent_id"
     OR new."archived_at" IS DISTINCT FROM old."archived_at" THEN
    PERFORM pg_notify('messenger_changed', json_build_object('c', new."id", 'seq', NULL, 'kind', 'participants', 'actor', NULL)::text);
  END IF;
  RETURN NULL;
END
$$;
