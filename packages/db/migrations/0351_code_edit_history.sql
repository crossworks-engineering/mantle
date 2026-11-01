-- The code tools (packages/tools/src/code/): `node_snapshots.trigger` gains
-- `pre_code_edit`. Every draft write through code_edit, code_insert,
-- code_write, code_undo, app_file_write, app_file_delete and app_source_set
-- first records what it changes (the files it changes as they were, and
-- the hash of what it leaves), code only, no database copy; the row's id is
-- the write's edit_id, which code_undo takes back. The newest
-- APP_CODE_EDIT_KEEP rows are kept per app, and the History list and the
-- lookups by id leave them out: an undo record, not a version anyone picks.
--
-- Additive, no new table, no trigger, no LLM work.
-- Revert: packages/db/rollback/0351_code_edit_history.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_trigger_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD CONSTRAINT "node_snapshots_trigger_ck" CHECK ("trigger" IN
  ('publish', 'commit', 'manual', 'pre_restore', 'pre_schema', 'pre_delete', 'pre_import', 'nightly',
   'pre_mcp_write', 'pre_code_edit'));
