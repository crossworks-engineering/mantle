-- The code tools (packages/tools/src/code/): `node_snapshots.trigger` gains
-- `pre_code_edit`. Every draft write through code_edit, code_insert,
-- code_write, code_undo, app_file_write and app_source_set first records the
-- app's code as it stood (code only, no database copy) on the app's own
-- history line, so code_undo can put one file back. The rows are pruned on
-- their own line (the newest APP_CODE_EDIT_KEEP per app) and the app's
-- History list leaves them out (listAppSnapshots), as an undo stack, not a
-- version anyone picks.
--
-- Additive, no new table, no trigger, no LLM work.
-- Revert: packages/db/rollback/0350_code_edit_history.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_trigger_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD CONSTRAINT "node_snapshots_trigger_ck" CHECK ("trigger" IN
  ('publish', 'commit', 'manual', 'pre_restore', 'pre_schema', 'pre_delete', 'pre_import', 'nightly',
   'pre_mcp_write', 'pre_code_edit'));
