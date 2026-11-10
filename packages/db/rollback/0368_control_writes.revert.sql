-- Rollback of 0368_control_writes: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Run it on a Control Center that goes back: the older image reads
-- model_job and model_result in the 0367 shape. This revert clears every
-- waiting job and the kept results (the older shape cannot hold a pool
-- entry, the update notice or a worker group), gives the two columns their
-- 0367 names back, and takes 0368 off the ledger, so the next roll forward
-- runs it again (every statement in 0368 is re-runnable). On a box that is
-- not a CC the table is empty and it only renames and moves the ledger.
-- Then run 0367's revert too if the image goes back past 0367.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0368_control_writes.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."control_boxes" SET "write_job" = NULL, "write_result" = NULL
  WHERE "write_job" IS NOT NULL OR "write_result" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."control_boxes" RENAME COLUMN "write_job" TO "model_job";
--> statement-breakpoint
ALTER TABLE "public"."control_boxes" RENAME COLUMN "write_result" TO "model_result";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791950000000;
