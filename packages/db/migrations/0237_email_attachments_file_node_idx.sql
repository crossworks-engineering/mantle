-- Access matrix fixes, audit LOW-4: an index on email_attachments.file_node_id.
-- Mail sync and the Files delete guard look attachments up by their file node
-- (packages/files/src/ops/files.ts), and the table had indexes on email_id and
-- sha256 only, so each such lookup read the whole table.
--
-- Rollback: drop the index; nothing depends on it.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_attachments_file_node_idx"
  ON "public"."email_attachments" ("file_node_id");
