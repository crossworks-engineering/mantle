-- Workspaces arch A3b part 2, store brokers (docs/store-brokers.md, plan
-- 20.3): the snapshot store's tombstones.
--
-- A snapshot's database file (node_snapshots.db_path) and an accepted
-- table's workbook copy (accepted_snapshots.table_path) used to be removed
-- by whoever removed the row, after it, outside any transaction: a crash in
-- between left a file no row named (kept for ever), and a backup that
-- dumped the row before the delete could find its file gone. Now a row's
-- file is never removed by the writer: the delete (or the change of path)
-- records the file it leaves in store_tombstones, in the same transaction,
-- by the triggers below (every path that deletes these rows: a delete, a
-- prune, a purge, a deleted node's cascade). The one store sweep removes a
-- tombstoned file a grace period after its row went, and only while no row
-- names it. A file with neither a row nor a tombstone is only reported.
--
-- Tombstones live in the database with the rows, so a restore brings back
-- exactly the tombstones of the rows it does not bring back. A path named
-- again and dropped again starts its day over (the time is the latest
-- row's going, never an older one's).
--
-- The table is the system pool's (row level security on, no policy, no
-- grant): the triggers are definers, so a member's delete of its own
-- snapshot records its tombstone too. Never waiting past 30 s behind live
-- traffic (as 0283).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."store_tombstones" (
  -- 'appsnap' (relative to APP_DB_DIR), 'tablesnap' and 'accepted'
  -- (relative to TABLE_DB_DIR).
  "store"      text NOT NULL,
  "path"       text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("store", "path")
);
--> statement-breakpoint
ALTER TABLE "public"."store_tombstones" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Both tables' trigger locks first, in one statement (as 0283).
LOCK TABLE "public"."node_snapshots", "public"."accepted_snapshots" IN SHARE ROW EXCLUSIVE MODE;
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
CREATE OR REPLACE FUNCTION "public"."mantle_accepted_tombstone_trg"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.table_path IS NULL OR OLD.table_path = '' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_path IS NOT DISTINCT FROM OLD.table_path THEN RETURN NULL; END IF;
  INSERT INTO "public"."store_tombstones" ("store", "path")
  VALUES ('accepted', OLD.table_path)
  ON CONFLICT ("store", "path") DO UPDATE SET "created_at" = clock_timestamp();
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_accepted_tombstone_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "node_snapshots_tombstone" ON "public"."node_snapshots";
--> statement-breakpoint
CREATE TRIGGER "node_snapshots_tombstone" AFTER DELETE OR UPDATE OF "db_path"
  ON "public"."node_snapshots" FOR EACH ROW
  EXECUTE FUNCTION "public"."mantle_snapshot_tombstone_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "accepted_snapshots_tombstone" ON "public"."accepted_snapshots";
--> statement-breakpoint
CREATE TRIGGER "accepted_snapshots_tombstone" AFTER DELETE OR UPDATE OF "table_path"
  ON "public"."accepted_snapshots" FOR EACH ROW
  EXECUTE FUNCTION "public"."mantle_accepted_tombstone_trg"();
