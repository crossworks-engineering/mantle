-- Draft/publish split for pages. The editor autosaves into `draft_doc`
-- (cheap, never rendered or indexed); commit promotes it into `doc` and fires
-- the extractor. `draft_doc` is null when there are no uncommitted edits.

ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "draft_doc" jsonb;
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "draft_updated_at" timestamp with time zone;
