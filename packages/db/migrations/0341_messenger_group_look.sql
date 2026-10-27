-- A group's look (Messenger V1, plan page d8954876 section 23): an icon (an
-- emoji, at most 16 characters) and a colour (an app tint key, APP_TINTS in
-- @mantle/client-types/app-nav: the key, never a colour, so each theme
-- draws its own) on messenger_conversations. Both nullable; a direct chat
-- has neither (the check). The tint list is held by the code that writes
-- them (@mantle/content/messenger), not here: a new tint needs no migration.
--
-- The workspace role reads both columns (ACCESS_MATRIX lists them with the
-- other room columns; migrate grants the named columns). A change of either
-- raises the room's `participants` event, as a title change does: the
-- conversations trigger function is replaced with both columns added to
-- what a reader shows (CREATE OR REPLACE, the same signature).
--
-- No LLM work, no queue row, no cron: nothing here can start a turn.
--
-- Rollback: packages/db/rollback/0341_messenger_group_look.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- Every table this migration alters, in one statement before the first
-- change.
LOCK TABLE "public"."messenger_conversations" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

ALTER TABLE "public"."messenger_conversations"
  ADD COLUMN IF NOT EXISTS "icon" text,
  ADD COLUMN IF NOT EXISTS "color" text;
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  DROP CONSTRAINT IF EXISTS "messenger_conversations_look_ck";
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  ADD CONSTRAINT "messenger_conversations_look_ck" CHECK (
    ("icon" IS NULL OR char_length("icon") BETWEEN 1 AND 16)
    AND ("color" IS NULL OR "color" ~ '^[a-z]{1,16}$')
    AND ("kind" = 'group' OR ("icon" IS NULL AND "color" IS NULL)));
--> statement-breakpoint

-- Only what a reader shows changes the room: the title, the picture, the
-- icon and colour, the workspace, the agent, archived. A send's last_seq
-- bump is the message's own event.
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
