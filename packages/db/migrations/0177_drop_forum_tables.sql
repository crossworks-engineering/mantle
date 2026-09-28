-- Member logins, Phase 6: the retired team forum's tables are dropped.
-- The forum was closed to writes in 0.232.293, every topic was exported into
-- the admin-level "Forum archive" pages (nodes with data.source =
-- 'forum-archive') plus a JSON dump file, and stage 5 (0.232.295) deleted the
-- forum routes and its turn runner. Only the export read these tables; it goes
-- with them. The archive pages, the files the export filed, the dump and every
-- row outside the four forum tables stay.
--
-- The foreign keys, as the live catalog has them (migrations 0123 and 0126):
--   forum_posts.topic_id               -> forum_topics  ON DELETE CASCADE
--   forum_uploads.topic_id             -> forum_topics  ON DELETE CASCADE
--   forum_uploads.post_id              -> forum_posts   ON DELETE CASCADE
--   forum_topics.created_by_contact_id -> nodes         ON DELETE SET NULL
--   forum_posts.contact_id             -> nodes         ON DELETE SET NULL
--   forum_posts.agent_id               -> agents        ON DELETE SET NULL
--   forum_uploads.contact_id           -> nodes         ON DELETE SET NULL
-- No other table references a forum table (forum_read_cursors and
-- team_notifications carry topic ids with no FK). Every FK above is dropped
-- by name first, then each table is dropped WITHOUT CASCADE: a dependency
-- this file does not know about (a view, an FK added by hand) fails the
-- migration instead of being dropped silently. Dropping a table deletes no
-- row anywhere else: an FK action fires on a row delete, never on a drop.
--
-- A topic with no archive page (node_id null) aborts the migration: its
-- content exists nowhere else. Every box exported all its topics before this
-- release; on one that did not, run the export on the previous release
-- (POST /api/team-admin/forum/export) and upgrade again.
--
-- Idempotent: IF EXISTS everywhere, so a second run does nothing.
DO $$
BEGIN
  IF to_regclass('public.forum_topics') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "forum_topics" WHERE "node_id" IS NULL) THEN
      RAISE EXCEPTION
        'drop forum tables aborted: a forum topic has no Forum archive page yet. Run the forum export on the previous release (POST /api/team-admin/forum/export), then upgrade again. See docs/team-forum.md section 8.';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE IF EXISTS "forum_uploads" DROP CONSTRAINT IF EXISTS "forum_uploads_topic_id_fkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "forum_uploads" DROP CONSTRAINT IF EXISTS "forum_uploads_post_id_fkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "forum_uploads" DROP CONSTRAINT IF EXISTS "forum_uploads_contact_id_fkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "forum_posts" DROP CONSTRAINT IF EXISTS "forum_posts_topic_id_fkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "forum_posts" DROP CONSTRAINT IF EXISTS "forum_posts_contact_id_fkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "forum_posts" DROP CONSTRAINT IF EXISTS "forum_posts_agent_id_fkey";
--> statement-breakpoint
ALTER TABLE IF EXISTS "forum_topics" DROP CONSTRAINT IF EXISTS "forum_topics_created_by_contact_id_fkey";
--> statement-breakpoint
DROP TABLE IF EXISTS "forum_uploads";
--> statement-breakpoint
DROP TABLE IF EXISTS "forum_read_cursors";
--> statement-breakpoint
DROP TABLE IF EXISTS "forum_posts";
--> statement-breakpoint
DROP TABLE IF EXISTS "forum_topics";
