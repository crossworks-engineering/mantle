-- Rollback of 0350_oidc_handoff_codes: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image works with 0350 in place. It never reads or
-- writes the table, and the older migrate's grants leave a table its access
-- matrix does not list closed to the workspace and narrow roles. Nothing in
-- the table is worth keeping (a code lasts 2 minutes), so this revert drops it
-- and takes 0350 off the ledger, so the next roll forward runs it again.
--
-- Bearers company sign-in made stay in mobile_tokens. The older image reads
-- their `so` claim as nothing and takes them for password bearers until they
-- end (MANTLE_OIDC_SESSION_HOURS, 12 by default): end them first with Sign out
-- everywhere when that matters.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0350_oidc_handoff_codes.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."oidc_handoff_codes";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790632860000;
