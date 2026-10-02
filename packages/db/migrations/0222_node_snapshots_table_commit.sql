-- Tables join the history line (apps first-class plan, Phase 4). A table
-- commit now keeps the published workbook it replaces as a `commit` row
-- (a file under TABLE_DB_DIR/_snapshots, db_path relative to TABLE_DB_DIR;
-- packages/content/src/table-snapshots.ts). The trigger list gains it.
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_trigger_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD CONSTRAINT "node_snapshots_trigger_ck" CHECK ("trigger" IN
  ('publish', 'commit', 'manual', 'pre_restore', 'pre_schema', 'pre_delete', 'pre_import', 'nightly'));
