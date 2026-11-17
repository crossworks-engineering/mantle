-- Rollback of 0377_agent_text_key: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image never writes `agent_text`, so the list with it
-- answers as before for every write it makes. This puts 0339's list back
-- and takes 0377 off the ledger, so the next roll forward applies it again.
-- An `agent_text` key already on a node STAYS, and a plain search still
-- finds its words: the older image does not know the key, so an overwrite
-- of the file and the name-only mode do NOT drop it. To take the words out
-- of search too, the operator runs, in the same transaction:
--   SELECT set_config('mantle.keep_updated_at', 'on', true);
--   UPDATE nodes SET data = data - 'agent_text' WHERE data ? 'agent_text';
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0377_agent_text_key.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest', 'parser_failures']::text[]
$$;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792060000000;
