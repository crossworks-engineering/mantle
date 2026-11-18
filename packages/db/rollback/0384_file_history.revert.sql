-- Rollback of 0384_file_history: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- The older image writes no file rows and never reads them. This removes
-- the file rows (their files are recorded for the store sweep by the
-- tombstone trigger, under 'filesnap', which the older image's sweep does
-- not read: remove MANTLE_FILES_ROOT/.file-history by hand afterwards if
-- the space is wanted), puts back the 0219/0351 checks, the 0284 trigger
-- body and the 0300 budget, drops the index and takes 0384 off the ledger.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0384_file_history.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "public"."node_snapshots" WHERE "node_kind" = 'file';
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."node_snapshots_file_created_idx";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_kind_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD CONSTRAINT "node_snapshots_kind_ck"
  CHECK ("node_kind" IN ('app', 'table'));
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_trigger_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD CONSTRAINT "node_snapshots_trigger_ck" CHECK ("trigger" IN
  ('publish', 'commit', 'manual', 'pre_restore', 'pre_schema', 'pre_delete', 'pre_import', 'nightly',
   'pre_mcp_write', 'pre_code_edit'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_snapshot_tombstone_trg"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.db_path IS NULL OR OLD.db_path = '' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.db_path IS NOT DISTINCT FROM OLD.db_path THEN RETURN NULL; END IF;
  INSERT INTO "public"."store_tombstones" ("store", "path")
  VALUES (CASE WHEN OLD.node_kind = 'table' THEN 'tablesnap' ELSE 'appsnap' END, OLD.db_path)
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
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
     AND (NOT manual_only OR s."trigger" = 'manual')
     AND (member IS NULL OR (s."actor" = 'member') = member)
     AND (login IS NULL OR s."actor_login_id" = login)
$$;
--> statement-breakpoint
DELETE FROM "public"."store_tombstones" WHERE "store" = 'filesnap';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792160000000;
