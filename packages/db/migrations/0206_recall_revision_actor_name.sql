-- Recall v2: name the actor on each revision (audit 2026-09-30, finding M5).
--
-- recall_revisions stored actor_kind and actor_id only, and the agent tools
-- had no id to give, so the log could say "an agent" but never which one. The
-- revisions panel exists largely to audit agent edits, which serve at once.
-- The name is STORED rather than joined: an agent or an admin can be deleted,
-- and the log must still say who made the change.
--
-- Rollback: the previous release names its columns on insert and never reads
-- this one; the column is nullable and old rows keep NULL. To undo, drop it.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."recall_revisions"
  ADD COLUMN IF NOT EXISTS "actor_name" text;
