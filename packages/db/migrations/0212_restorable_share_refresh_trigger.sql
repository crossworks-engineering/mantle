-- A restored brain keeps its folder share refresh (restore rehearsal,
-- 2026-10-01; docs/folder-tree.md, "Sharing a folder").
--
-- 0204 made the trigger nodes_share_refresh_after with a WHEN clause that
-- compares the `path` column itself: OLD."path" IS DISTINCT FROM NEW."path".
-- `path` is an ltree, a type the ltree extension puts in schema public.
-- pg_dump writes an ordinary operator on such a type with its schema
-- (OPERATOR(public.=)), but IS DISTINCT FROM has no place to name the schema
-- of the `=` behind it, and pg_restore runs with an empty search_path. So
-- every restore of a dump taken at 0204 or later failed on this one
-- statement:
--
--   ERROR:  operator does not exist: public.ltree = public.ltree
--
-- and the restored brain had no nodes_share_refresh_after trigger. Sharing
-- or unsharing a folder, or moving or renaming one, then no longer refreshed
-- inherited_level on the rows below it. scripts/db-restore.sh went on past
-- the error and said "Restore complete, WITH 1 pg_restore error(s)". A brain
-- migrated in place always kept the trigger; only a restored one lost it.
--
-- How long it lasted: the nightly share-drift sweep (maintenance registry;
-- packages/content/src/tree/share-drift.ts) sets stale levels right, so on a
-- box whose maintenance worker runs, a stale level lived for about a day at
-- most. The sweep's run history (maintenance runner) shows whether a box
-- was hit: "repaired n of n drifted row(s)".
--
-- 1. The table lock comes first: ACCESS EXCLUSIVE on nodes, asked for while
--    this transaction holds nothing else, so the wait can be part of no
--    cycle. The owner share locks of 0207 are NOT taken. An insert takes its
--    lock on the table first and asks for the share lock after (in
--    mantle_nodes_inherit_trg), so a migration that held share locks and
--    then asked for the table could deadlock with any insert into a shared
--    owner's folders. With the table locked nobody else writes nodes at
--    all, which is all the share locks would give. Reads of nodes wait
--    while the repair runs: milliseconds on most brains, a few seconds on a
--    very large one with shares, as in 0208.
--    The wait is at most 30 s (lock_timeout). "lock timeout" on 0212 in a
--    roll means a long transaction held nodes: run the roll again.
-- 2. Repair. On a brain that ran without the trigger, a row below a folder
--    that was shared, unshared, moved or renamed since the last sweep holds
--    a stale inherited_level (after an unshare it fails OPEN: still read at
--    the old share). Every row of every owner that has a shared folder, or
--    a row that still holds an inherited share, is set to what 0204's rule
--    gives (mantle_inherited_level); only rows that differ are written, so
--    a brain that never lost the trigger is not written at all. Each change
--    fires nodes_embed_reach_after (0208), so what those rows embed
--    follows.
-- 3. The trigger is made again with the same rule on the TEXT form of the
--    path. Text is compared by a pg_catalog operator, which a restore always
--    finds. Two ltree values are equal exactly when their text is, so the
--    trigger fires for the same rows as before. The function is unchanged
--    (0207).
--
-- A brain that was restored without the trigger gets it back here, on its
-- next migrate.
--
-- The rule for new migrations: never IS DISTINCT FROM, NULLIF or a simple
-- CASE on a column of an extension type (ltree, vector) in anything the
-- database stores as an expression (a trigger WHEN, a CHECK, a generated
-- column, an index, a policy, a view). Cast to text first.
-- packages/db/src/dump-restore.db.test.ts dumps and restores the migrated
-- schema and fails on any statement a restore cannot run.
--
-- Idempotent: a second run finds no stale row and writes nothing; the
-- trigger is DROP IF EXISTS, then CREATE.
--
-- Number and order: 0211 is held by a branch that is not on main yet. This
-- `when` (1790019000000) is above 0210's. The runner applies only entries
-- above the highest applied `when`, so a migration that lands after this
-- one must carry a higher stamp, whatever its number: a box that already
-- ran 0212 skips a lower one for ever.
--
-- Rollback: the previous release keeps working with this trigger (same
-- rows, same function).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

LOCK TABLE "public"."nodes" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

DO $$
DECLARE
  r record;
  n bigint;
  total bigint := 0;
BEGIN
  FOR r IN SELECT DISTINCT x."owner_id" FROM "public"."nodes" x
            WHERE x."share_level" IS NOT NULL OR x."inherited_level" IS NOT NULL
            ORDER BY 1 LOOP
    UPDATE "public"."nodes" x
       SET "inherited_level" = "public"."mantle_inherited_level"(x."owner_id", x."path", x."type")
     WHERE x."owner_id" = r."owner_id"
       AND x."inherited_level" IS DISTINCT FROM
           "public"."mantle_inherited_level"(x."owner_id", x."path", x."type");
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;
  IF total > 0 THEN
    RAISE NOTICE '0212: % row(s) held a stale inherited_level (a restore lost the share refresh trigger); repaired', total;
  END IF;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "nodes_share_refresh_after" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_share_refresh_after"
  AFTER UPDATE OF "path", "share_level" ON "public"."nodes"
  FOR EACH ROW
  WHEN (NEW."type" = 'branch'
        AND (OLD."path"::text IS DISTINCT FROM NEW."path"::text
             OR OLD."share_level" IS DISTINCT FROM NEW."share_level"))
  EXECUTE FUNCTION "public"."mantle_nodes_refresh_trg"();
