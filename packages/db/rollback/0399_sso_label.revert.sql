-- Rollback of 0399_sso_label: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- An older image reads the button's label from MANTLE_OIDC_LABEL only. A box
-- whose label came from a screen then shows the default ("Single sign-on"),
-- unless its .env says a label. To keep the word after the pin, write
-- MANTLE_OIDC_LABEL into the .env first.
--
-- The older image works with 0399 in place and never reads the new column.
-- This revert clears the label (so a later roll forward shows the default
-- until a screen sets it again), clears the Control Center's admin channel
-- calls (an older CC would not know a waiting save with a label; send it
-- again after the roll forward), and takes 0399 off the ledger, so the next
-- roll forward runs it again (0399 is re-runnable).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0399_sso_label.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."sso_setup" SET "label" = NULL WHERE "label" IS NOT NULL;
--> statement-breakpoint
UPDATE "public"."control_boxes" SET "tool_job" = NULL WHERE "tool_job" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792340300000;
