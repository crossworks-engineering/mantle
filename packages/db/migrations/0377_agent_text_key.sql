-- The text of the Agents' tabs on a file node (docs/pipelines.md, "Agents",
-- "The fields in the file's text"): `data.agent_text`, one text for each
-- Agent by its id, written by the run of an Agent
-- (server/api/src/agent/extract/agent-text.ts) after its write of the
-- tabs. `search_tsv` is generated over the whole data blob, so a plain
-- search finds the fields and the list of a drawing.
--
-- It is one more of the keys the extractor writes about a file's bytes, so
-- it joins that list (0281, 0339): a non-system write may clear it (a file
-- overwrite drops it with the other byte keys), never set it, and the
-- name-only mode strips it with `text`. Only the list changes (CREATE OR
-- REPLACE, the same signature): every check that reads it is untouched.
-- Re-runnable.
--
-- Rollback: packages/db/rollback/0377_agent_text_key.revert.sql puts 0339's
-- list back; the older image never writes the key.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest', 'parser_failures', 'agent_text']::text[]
$$;
