-- Rollback of 0335_tree_rank_presentation: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional: the older image never writes `tree_rank`, so the list with it
-- answers as before for every write it makes. This puts 0281's list back
-- (a member with Write on a folder can then no longer change an item's
-- `tree_rank` alone) and takes 0335 off the ledger, so the next roll
-- forward applies it again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0335_tree_rank_presentation.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_node_presentation_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['rank']::text[]
$$;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200260000;
