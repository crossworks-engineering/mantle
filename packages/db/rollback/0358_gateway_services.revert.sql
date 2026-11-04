-- Rollback of 0358_gateway_services: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image works with 0358 in place. It never reads or
-- writes `gateway_services` or `gateway_calls` (an older compose runs no
-- gateway), and the older migrate's grants leave a table its access matrix
-- does not list closed to the workspace role. So this revert keeps both
-- tables and their rows: it only takes 0358 off the ledger, so the next roll
-- forward runs it again (every statement in 0358 is IF NOT EXISTS).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0358_gateway_services.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791324060000;
