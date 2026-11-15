-- Rollback of 0375_pipeline_state_off_in: what an operator runs before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- You MUST run it before pinning the older image: 0375 renames the column
-- `workspaces` that the older image reads, so without it every read of a
-- pipeline's state fails there.
--
-- It clears every off list first: the older image reads the column as an
-- ALLOW list of an `after` pipeline, so an off list kept as it is would run
-- the pipeline in exactly the workspaces it was off in. NULL is the older
-- image's default (an `after` pipeline attached to no workspace, a reader
-- in every one). The options and the count of runs are kept. Then it gives
-- the column its 0373 name back and takes 0375 off the ledger, so the next
-- roll forward runs it again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0375_pipeline_state_off_in.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."pipeline_state" SET "off_in" = NULL WHERE "off_in" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."pipeline_state" RENAME COLUMN "off_in" TO "workspaces";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792040000000;
