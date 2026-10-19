-- Rollback of 0309_ws_row_definers: what an operator runs BEFORE pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not
-- a migration: nothing runs it on its own.
--
-- Why it is short: 0309 only adds functions. It changes no table, row,
-- trigger, grant or earlier function, so the image before it (which writes
-- the workspace row, the landing app and the archive in TypeScript on the
-- system pool) works with 0309 in place. This file makes the catalog
-- exactly that image's again: it drops the five functions 0309 added
-- (that image never calls them) and takes 0309 off the ledger, so a later
-- roll forward applies it again (it is re-runnable). The 0309 cell "the
-- revert drops 0309's functions" checks it against a database just before
-- 0309.
--
-- Run it while the newer image is still up (this file is in its image,
-- not in a box's stack directory), as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0309_ws_row_definers.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback"),
-- or stop mantle_web first: from the revert to the pin the newer image's
-- workspace rename, landing app and archive are refused (their definers
-- are gone), and a restart in between runs its boot migrate, which applies
-- 0309 again. 0309 ships in its own release, so a one-image rollback
-- crosses only 0309.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_ws_update_about"(uuid, uuid, jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_ws_set_contact"(uuid, uuid, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_ws_set_landing"(uuid, uuid, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_ws_app_held"(uuid, uuid, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_ws_archive"(uuid, uuid);
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0309 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790197860000;
