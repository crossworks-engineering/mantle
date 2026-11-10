-- Rollback of 0367_control_models: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Run it on a Control Center that goes back: the older image works with 0367
-- in place and never reads the two new columns of control_boxes, but it
-- never sends a waiting model job either. This revert clears every waiting
-- job (model_result stays), keeps the columns, and takes 0367 off the
-- ledger, so the next roll forward runs it again (every statement in 0367 is
-- re-runnable). On a box that is not a CC the table is empty and it only
-- moves the ledger.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0367_control_models.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."control_boxes" SET "model_job" = NULL WHERE "model_job" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791940000000;
