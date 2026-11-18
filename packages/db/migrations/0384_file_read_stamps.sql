-- What read a file (docs/files.md, "Reindex and stale indexes"): two stamps
-- on a file node's data, written by the brain only.
--  - `read_by` { reader, v }: a completed read of the file's text, by the
--    core reader of its type at that reader's version
--    (server/api/src/agent/extractor.ts, extract/gates.ts);
--  - `pipeline_read` { id, name, version }: the Reader pipeline that built
--    the file's database (packages/content/src/file-database.ts).
-- A file is stale when a stamp is below the version in force (a number in
-- packages/files/src/read-stamp.ts, or the installed pipeline's version).
--
-- 1. Both describe the bytes, so they join the extractor's keys (0281, 0339,
--    0377): a non-system write may clear them (a file overwrite drops them
--    with the other byte keys), never set them. Only the list changes
--    (CREATE OR REPLACE, the same signature).
-- 2. Two partial indexes for the stale list (GET /api/files/stale): the
--    files a reader read below its version, and the files a pipeline read at
--    another version than the installed one, are found in the index, not by
--    a pass over every file's data. Only stamped file rows are in them; no
--    cast in an index expression, so no value can make a write fail.
--
-- Lock cost: a plain CREATE INDEX (a migration runs in a transaction, so not
-- CONCURRENTLY) takes a SHARE lock on nodes for the build: reads go on,
-- writes to nodes wait while one pass over the table runs (as 0246). The
-- indexes start empty in practice: no row has a stamp before this ships. The
-- lock wait is capped at 5 s; on a timeout the migration fails and is
-- re-runnable. No trigger, no notify, nothing that starts work.
--
-- Rollback: packages/db/rollback/0384_file_read_stamps.revert.sql.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest', 'parser_failures', 'agent_text',
               'read_by', 'pipeline_read']::text[]
$$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "nodes_file_read_by_idx"
  ON "public"."nodes" (("data" -> 'read_by' ->> 'reader'), ("data" -> 'read_by' -> 'v'))
  WHERE "type" = 'file' AND "data" ? 'read_by';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "nodes_file_pipeline_read_idx"
  ON "public"."nodes" (("data" -> 'pipeline_read' ->> 'id'), ("data" -> 'pipeline_read' ->> 'version'))
  WHERE "type" = 'file' AND "data" ? 'pipeline_read';
