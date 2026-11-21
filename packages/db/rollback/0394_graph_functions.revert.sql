-- Rollback of 0394_graph_functions: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional: the older image never calls the functions (its graph_path
-- sends its own walk as text). This drops both and takes 0394 off the
-- ledger, so the next roll forward applies it again. No data is lost.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0394_graph_functions.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_graph_path"(uuid, uuid, uuid, integer, text[], boolean, boolean);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_graph_walk"(uuid, uuid, integer, text[], boolean, boolean, integer, uuid);
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792330000000;
