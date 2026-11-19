-- Rollback of 0385_file_read_stamps: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image never writes `read_by` or `pipeline_read`, and
-- never reads the two indexes. This puts 0377's list back, drops the two
-- indexes, and takes 0385 off the ledger, so the next roll forward applies
-- it again. Stamps already on nodes STAY; the older image does not know the
-- keys, so an overwrite of a file does not drop them, and a newer image
-- then reads a stamp of the old bytes (it shows the file as read, not as
-- stale, until its next read). To take them out too, in the same
-- transaction:
--   SELECT set_config('mantle.keep_updated_at', 'on', true);
--   UPDATE nodes SET data = data - 'read_by' - 'pipeline_read'
--    WHERE type = 'file' AND (data ? 'read_by' OR data ? 'pipeline_read');
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0385_file_read_stamps.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest', 'parser_failures', 'agent_text']::text[]
$$;
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."nodes_file_read_by_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."nodes_file_pipeline_read_idx";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792210000000;
