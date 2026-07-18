-- Forum file uploads with owner review — the "Phase 4" the forum schema
-- stubbed (forum_posts.attachments existed from day one).
--
-- A member's upload is QUARANTINED: bytes land on disk OUTSIDE the files
-- ltree (data/forum-uploads/<owner>/<id>, a sibling of the files root), so
-- the migration-0018 ingestion trigger never fires. The blob row is the
-- review state; the immutable post's attachments jsonb references it by
-- fileId. The owner triages in team-admin: "move to files" copies into
-- files/review/<topic-slug>/ (only THEN does ingestion run), "dismiss"
-- drops the bytes.
--
-- Lifecycle: staged (uploaded, no post yet) → pending (bound to a post,
-- awaiting owner review) → filed (in the files tree; node_id set) |
-- dismissed. Staged rows older than 24h are swept opportunistically.
--
-- topic_id is NULLABLE, deliberately deviating from the planning doc's
-- NOT NULL: the new-topic dialog stages uploads BEFORE its topic exists.
-- Binding (post-create, same transaction) sets topic_id + post_id together,
-- so every non-staged row has both.
--
-- contact_id goes SET NULL on contact deletion (same rule as forum_posts:
-- content outlives its author). post_id/topic_id CASCADE — deleting a topic
-- reaps its upload rows; the now-row-less quarantine bytes are reclaimed by
-- the reconcile pass's disk↔row scan (apps/web/lib/forum-quarantine.ts), NOT
-- by the row-driven staged sweep (which never sees a byte file with no row).

CREATE TABLE IF NOT EXISTS "forum_uploads" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"     uuid NOT NULL,
  "topic_id"     uuid REFERENCES "forum_topics"("id") ON DELETE CASCADE,
  "post_id"      uuid REFERENCES "forum_posts"("id") ON DELETE CASCADE,
  "contact_id"   uuid REFERENCES "nodes"("id") ON DELETE SET NULL,
  "filename"     text NOT NULL,
  "mime"         text NOT NULL,
  "size_bytes"   integer NOT NULL,
  "status"       text NOT NULL DEFAULT 'staged' CHECK ("status" IN ('staged', 'pending', 'filed', 'dismissed')),
  "node_id"      uuid,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "reviewed_at"  timestamptz
);--> statement-breakpoint
-- Drives the admin review queue (pending per owner) + the badge count.
CREATE INDEX IF NOT EXISTS "forum_uploads_owner_status_idx" ON "forum_uploads" ("owner_id", "status");--> statement-breakpoint
-- Post → its blobs (chip rendering joins through attachments.fileId, sweeps by post).
CREATE INDEX IF NOT EXISTS "forum_uploads_post_idx" ON "forum_uploads" ("post_id");--> statement-breakpoint
-- Per-contact daily byte budget (created_at window scan).
CREATE INDEX IF NOT EXISTS "forum_uploads_contact_created_idx" ON "forum_uploads" ("owner_id", "contact_id", "created_at");
