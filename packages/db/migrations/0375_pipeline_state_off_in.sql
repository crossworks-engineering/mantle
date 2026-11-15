-- Pipelines WO (docs/pipelines.md, "Where a pipeline runs"): a pipeline is on
-- in every workspace, and an Admin can switch it off in a workspace. The
-- list of pipeline_state (0373) turns from an ALLOW list of an `after`
-- pipeline into the OFF list of any pipeline but a router.
--
--  - The column `workspaces` is renamed `off_in`: a column named
--    `workspaces` that means "off in" would mislead every reader of the
--    schema.
--  - In the same step every list is set to NULL (the default of the code:
--    off nowhere). An old allow list must never be read as an off list: it
--    would switch a pipeline off in exactly the workspaces it was used in.
--    So after this every pipeline is on in every workspace.
--
-- Re-runnable: the rename and the clear run only while the column is still
-- named `workspaces`, so a second run changes nothing, and an off list an
-- Admin set after the first run stays. No trigger, no seed row, no grant,
-- and nothing here starts any work. One row per pipeline a box changed:
-- no rewrite of a large table.
-- Revert: packages/db/rollback/0375_pipeline_state_off_in.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'pipeline_state' AND column_name = 'workspaces') THEN
    ALTER TABLE "public"."pipeline_state" RENAME COLUMN "workspaces" TO "off_in";
    UPDATE "public"."pipeline_state" SET "off_in" = NULL WHERE "off_in" IS NOT NULL;
  END IF;
END $$;
