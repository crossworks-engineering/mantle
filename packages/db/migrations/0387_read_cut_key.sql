-- A read in part, said out loud (docs/files.md, "Read in part"): the readers'
-- cuts on a node's data, `data.read_cut`, one entry per kind of cut (rows of
-- a sheet, sheets of a workbook, characters of a text, pictures left out,
-- ...), written by the brain only: the extractor at the end of a read
-- (server/api/src/agent/extractor.ts, extract/gates.ts), an Agent's text
-- (extract/agent-text.ts), and a calendar feed's event
-- (packages/content/src/events.ts).
--
-- It describes the bytes as read, so it joins the extractor's keys (0281,
-- 0339, 0377, 0385, 0386): a non-system write may clear it (a file
-- overwrite drops it with the other byte keys), never set it. Only the list changes (CREATE
-- OR REPLACE, the same signature): every check that reads it is untouched.
-- No trigger, no notify, nothing that starts work. Re-runnable.
--
-- Rollback: packages/db/rollback/0387_read_cut_key.revert.sql puts 0386's
-- list back; the older image never writes the key.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest', 'parser_failures', 'agent_text',
               'read_by', 'pipeline_read', 'images', 'read_cut']::text[]
$$;
