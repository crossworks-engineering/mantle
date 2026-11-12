-- Rollback of 0371_sso_from_cc: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Before pinning: an older image reads the issuer and the client id from the
-- .env only. On a box whose values came from the Control Center, write them
-- into the .env first (scripts/sso-env.sh <box> --tenant .. --client ..), or
-- set the mode to off: an older image reads optional with no .env issuer as
-- off, and stops at boot on required with no .env issuer
-- (docs/oidc-sign-in.md, "Rollback").
--
-- The older image works with 0371 in place and never reads the new columns.
-- This revert keeps them and their values, clears the Control Center's
-- sign-in view (it is read again after the roll forward), and takes 0371 off
-- the ledger, so the next roll forward runs it again (0371 is re-runnable).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0371_sso_from_cc.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."control_boxes" SET "sso_view" = NULL WHERE "sso_view" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792000000000;
