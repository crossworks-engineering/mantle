-- Access matrix N6 (option A): a member deletes their OWN mini app to a trash
-- in their personal space, and brings it back from there.
--
-- `space_items.deleted_at`: set when the author moved the app to their
-- trash, null while it is live. Nothing is removed: the node, the app row,
-- its database file, its history and its activity all stay where they are,
-- so a restore is one column back to null. While it is set the app runs for
-- no one, no admin list shows it, and every change but the restore refuses
-- (member-space-apps.ts). No sweep ever deletes a trashed app: the nightly
-- app-trash purge only sees apps whose node is gone, and the space purge
-- never removes an app.
--
-- Only member-built apps use it today; no other space item kind reads it.
--
-- Rollback: the previous release never reads the column, so an app in a
-- trash shows again as a private draft of its author; nothing is lost.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."space_items"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_items_deleted_idx"
  ON "public"."space_items" ("author_login_id") WHERE "deleted_at" IS NOT NULL;
