-- Rollback of 0365_control_keys: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Run it on a Control Center that goes back: the older image works with 0365
-- in place and never reads the two new columns of control_boxes, but nothing
-- in it expires a key job, so a job still waiting would keep its sealed key.
-- This revert clears every waiting key job (key_result keeps no value and
-- stays), keeps the columns, and takes 0365 off the ledger, so the next roll
-- forward runs it again (every statement in 0365 is re-runnable). On a box
-- that is not a CC the table is empty and it only moves the ledger.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0365_control_keys.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."control_boxes" SET "key_job" = NULL WHERE "key_job" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791760000000;
