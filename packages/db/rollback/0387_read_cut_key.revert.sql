-- Rollback of 0387_read_cut_key: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image never writes `read_cut` and never reads it. This
-- puts 0386's list back and takes 0387 off the ledger, so the next roll
-- forward applies it again. Cuts already on nodes STAY; the older image does
-- not know the key, so an overwrite of a file does not drop it, and a newer
-- image then reads a cut of the old bytes (it shows the file as read in part
-- until its next read). To take them out too, in the same transaction:
--   SELECT set_config('mantle.keep_updated_at', 'on', true);
--   UPDATE nodes SET data = data - 'read_cut' WHERE data ? 'read_cut';
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0387_read_cut_key.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest', 'parser_failures', 'agent_text',
               'read_by', 'pipeline_read', 'images']::text[]
$$;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792190000000;
