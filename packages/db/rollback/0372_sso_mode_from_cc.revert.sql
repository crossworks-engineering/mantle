-- Rollback of 0372_sso_mode_from_cc: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- An older image reads the mode from the .env only. A box whose mode came
-- from the Control Center then reads off (passwords work as before), unless
-- its .env says a mode (docs/oidc-sign-in.md, "Rollback"). To keep sign-in on
-- after the pin, write the mode into the .env first
-- (scripts/sso-env.sh <box> --mode optional).
--
-- The older image works with 0372 in place and never reads the new column.
-- This revert clears the mode (so a later roll forward does not turn sign-in
-- back on by itself: the CC raises it again, one step at a time), clears the
-- Control Center's admin channel calls (an older CC would not know a waiting
-- sso_mode call; send it again after the roll forward), and takes 0372 off
-- the ledger, so the next roll forward runs it again (0372 is re-runnable).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0372_sso_mode_from_cc.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."sso_setup" SET "mode" = NULL WHERE "mode" IS NOT NULL;
--> statement-breakpoint
UPDATE "public"."control_boxes" SET "tool_job" = NULL WHERE "tool_job" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792010000000;
