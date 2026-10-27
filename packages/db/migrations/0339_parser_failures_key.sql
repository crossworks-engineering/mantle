-- The parser's failure count on a file node (docs/parser.md, "Errors"):
-- `data.parser_failures`, keyed by the job and the bytes' sha256, written by
-- the extractor (server/api/src/agent/extract/parser-failures.ts) when the
-- parser service times out on, crashes on or refuses as too large a file's
-- bytes. Kept on the node, so the count survives a restart or a roll: the
-- second counted failure is terminal whatever happened in between.
--
-- It is one more of the keys the extractor writes about a file's bytes, so
-- it joins that list (0281): a non-system write may clear it (a file
-- overwrite drops it with the other byte keys), never set it, and the
-- extractor may write it on a read-only snapshot copy as it writes the
-- others. Only the list changes (CREATE OR REPLACE, the same signature):
-- every check that reads it is untouched. Re-runnable.
--
-- Rollback: packages/db/rollback/0339_parser_failures_key.revert.sql puts
-- 0281's list back; the older image never writes the key.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest', 'parser_failures']::text[]
$$;
