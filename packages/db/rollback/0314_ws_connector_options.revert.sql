-- Rollback of 0314_ws_connector_options: what an operator runs BEFORE
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Why it is short: 0314 only adds one read function. It changes no table,
-- row, trigger, grant or earlier function, so the image before it (whose
-- workspace screen lists the MCP connectors only) works with 0314 in place.
-- This file makes the catalog exactly that image's again: it drops the
-- function (that image never calls it) and takes 0314 off the ledger, so a
-- later roll forward applies it again (it is re-runnable). The 0314 cell
-- "the revert drops 0314's function" checks it against a database just
-- before 0314.
--
-- Run it while the newer image is still up (this file is in its image,
-- not in a box's stack directory), as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0314_ws_connector_options.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback"),
-- or stop mantle_web first: from the revert to the pin the newer image's
-- "add connector" list fails (the function is gone), and a restart in
-- between runs its boot migrate, which applies 0314 again.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_ws_connector_options"(uuid);
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0314 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198160000;
