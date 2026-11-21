-- The Control Center broadcast (docs/control-center.md "Broadcast",
-- docs/messenger.md "Announcements"): an Admin at the CC sends one message
-- to every person on the fleet.
--
-- On the CC only (empty on every other box):
--  - control_broadcasts: one row per broadcast: the title (optional), the
--    text, who sent it, the boxes it goes to (named when it was made), and
--    one mark per box in `marks` ({at} once the box took it, else the last
--    failure {reason, tried}). The control service's run sends it to each
--    box with no `at` yet, so a box that is down gets it on a later run.
--    Never deleted, never dropped.
--
-- On every box:
--  - messenger_conversations.announcements: the box's one Announcements
--    group (a group only, no handle, no intake form). Only the system posts
--    in it: the signed `broadcast` case writes a system line there. Members
--    send nothing in it. One live one per box (a unique index).
--
-- No LLM work, no queue row, no cron: the CC's run that exists sends it,
-- and a system line starts no agent turn.
--
-- Grants come from the access matrix (applyViewerGrants), never from here.
-- Additive, no rewrite. Re-runnable.
-- Rollback: packages/db/rollback/0395_fleet_broadcast.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- Every table this migration alters, in one statement before the first
-- change.
LOCK TABLE "public"."messenger_conversations" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

ALTER TABLE "public"."messenger_conversations"
  ADD COLUMN IF NOT EXISTS "announcements" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  DROP CONSTRAINT IF EXISTS "messenger_conversations_announcements_ck";
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations"
  ADD CONSTRAINT "messenger_conversations_announcements_ck" CHECK (
    NOT "announcements"
    OR ("kind" = 'group' AND "handle" IS NULL AND "intake" IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_conversations_announcements_uq"
  ON "messenger_conversations" ("owner_id")
  WHERE "announcements" AND "archived_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."control_broadcasts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text,
  "body" text NOT NULL,
  "made_by" text NOT NULL,
  "made_at" timestamp with time zone DEFAULT now() NOT NULL,
  "box_ids" uuid[] NOT NULL,
  "marks" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "control_broadcasts_title_ck" CHECK ("title" IS NULL OR char_length("title") <= 200),
  CONSTRAINT "control_broadcasts_body_ck" CHECK (char_length("body") BETWEEN 1 AND 8000),
  CONSTRAINT "control_broadcasts_boxes_ck" CHECK (cardinality("box_ids") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "control_broadcasts_made_at_idx"
  ON "public"."control_broadcasts" ("made_at");
