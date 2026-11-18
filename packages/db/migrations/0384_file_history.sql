-- File history (Files program P3, owner's decisions 2026-11-18;
-- docs/files.md, "File history").
--
-- A file joins the numbered history line apps and tables have
-- (node_snapshots, node_kind 'file'). When new bytes replace a file (an
-- upload with replace, an edit, an export saved again), the bytes they
-- replace are kept as a 'replace' row: a file under the files root's
-- history folder (MANTLE_FILES_ROOT/.file-history/<owner>/<file>/<id>.bin,
-- db_path relative to that folder), db_bytes its size, source_hash its
-- sha256. A restore keeps the bytes it replaces as a 'pre_restore' row, so
-- a restore is undone the same way. The newest FILE_HISTORY_KEEP rows stay
-- per file and FILE_HISTORY_MAX_MB for the whole box, oldest pruned first
-- (packages/files/src/file-history.ts).
--
--  - node_snapshots_kind_ck takes 'file'; node_snapshots_trigger_ck takes
--    'replace'.
--  - The tombstone trigger (0284) records a file row's file in its own store
--    part, 'filesnap', so the one store sweep removes it from the right root.
--  - mantle_snapshot_bytes (0300), the budget of an owner's app and table
--    snapshots (APP_SNAPSHOT_MAX_MB), leaves file rows out: file history has
--    its own cap.
--  - One partial index for the box cap's prune (newest first over every file
--    row).
--
-- Rows only, no new table, no trigger that runs work, no LLM work. Rights
-- are the existing ones: a row is read where its file is read (0265) and
-- written with edit of its file (the access matrix's edit check).
-- Revert: packages/db/rollback/0384_file_history.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_kind_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD CONSTRAINT "node_snapshots_kind_ck"
  CHECK ("node_kind" IN ('app', 'table', 'file'));
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_trigger_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD CONSTRAINT "node_snapshots_trigger_ck" CHECK ("trigger" IN
  ('publish', 'commit', 'manual', 'pre_restore', 'pre_schema', 'pre_delete', 'pre_import', 'nightly',
   'pre_mcp_write', 'pre_code_edit', 'replace'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_snapshot_tombstone_trg"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.db_path IS NULL OR OLD.db_path = '' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.db_path IS NOT DISTINCT FROM OLD.db_path THEN RETURN NULL; END IF;
  INSERT INTO "public"."store_tombstones" ("store", "path")
  VALUES (CASE OLD.node_kind WHEN 'table' THEN 'tablesnap' WHEN 'file' THEN 'filesnap' ELSE 'appsnap' END,
          OLD.db_path)
  ON CONFLICT ("store", "path") DO UPDATE SET "created_at" = clock_timestamp();
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_snapshot_tombstone_trg"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_snapshot_bytes"(owner uuid, manual_only boolean, member boolean, login uuid)
  RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT coalesce(sum(s."db_bytes"), 0)::bigint
    FROM "public"."node_snapshots" s
   WHERE s."owner_id" = owner
     AND s."node_kind" <> 'file'
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
     AND (NOT manual_only OR s."trigger" = 'manual')
     AND (member IS NULL OR (s."actor" = 'member') = member)
     AND (login IS NULL OR s."actor_login_id" = login)
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "node_snapshots_file_created_idx"
  ON "public"."node_snapshots" ("created_at" DESC) WHERE "node_kind" = 'file';
