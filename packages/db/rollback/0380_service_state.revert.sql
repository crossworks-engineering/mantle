-- Rollback of 0380_service_state: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image works with 0380 in place. It never reads or
-- writes `service_state`, and the older migrate's grants leave a table its
-- access matrix does not list closed to the runtime roles. Dropping the
-- table loses every account the Sync service linked since (their sealed
-- settings and passwords, the feeds, the cursors): keep it unless the
-- service is gone for good. Stored mail and events stay either way.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0380_service_state.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."service_state";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792110000000;
