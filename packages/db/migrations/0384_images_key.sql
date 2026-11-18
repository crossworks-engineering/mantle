-- The pictures a file left out (task 8d40932a, G4): `data.images =
-- { kept, found }`, written by the picture pass of the extract
-- (server/api/src/agent/extract/images.ts) when a file has more pictures
-- than the per-document cap keeps, or a page window of it could not be
-- read. `extractionOf` (packages/files/src/extraction-status.ts) then shows
-- the file as `partial`, "N of M pictures kept", and a raised cap makes the
-- file a candidate of the picture pass again (G5). A file with no picture
-- left out stamps nothing.
--
-- It is one more of the keys the extractor writes about a file's bytes, so
-- it joins that list (0281, 0339, 0377): a non-system write may clear it (a
-- file overwrite drops it with the other byte keys), never set it. Only the
-- list changes (CREATE OR REPLACE, the same signature): every check that
-- reads it is untouched. Re-runnable.
--
-- Rollback: packages/db/rollback/0384_images_key.revert.sql puts 0377's
-- list back; the older image never writes the key.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest', 'parser_failures', 'agent_text', 'images']::text[]
$$;
