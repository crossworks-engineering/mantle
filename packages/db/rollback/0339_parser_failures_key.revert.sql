-- Rollback of 0339_parser_failures_key: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional: the older image never writes `parser_failures`, so the list
-- with it answers as before for every write it makes. This puts 0281's list
-- back and takes 0339 off the ledger, so the next roll forward applies it
-- again. A `parser_failures` key already on a node stays; nothing reads it
-- on the older image.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0339_parser_failures_key.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest']::text[]
$$;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200500000;
