-- The item tree: a deleted shared folder never leaves its share behind, and
-- the share refresh skips work on brains that share nothing (folder audit
-- 2026-09-30, X1 and P5; docs/folder-tree.md, "Sharing a folder").
--
-- 1. 0204 keeps nodes.inherited_level true on INSERT and on UPDATE of path
--    or share_level, but not on DELETE. A shared folder row deleted while
--    rows still sat below it (any writer that deletes a folder without first
--    lifting its contents: the Files folder delete did, for other kinds'
--    folders) left those rows readable at the old share, with no folder
--    anywhere to unshare. An AFTER DELETE row trigger on shared folder rows
--    recomputes everything that was below it. Only a folder that HAD a share
--    can leave one behind (a row below an unshared folder takes its share
--    from further up, which is still there), so the WHEN keeps every other
--    delete free.
--
-- 2. The AFTER UPDATE refresh (0204) rescanned a moved or renamed folder's
--    whole subtree even on a brain with no shared folder at all, where it
--    can change nothing. It now returns early unless the owner has a shared
--    folder (the 0204 partial index answers that) or something below still
--    carries an inherited share (the last share just removed).
--
-- Number and order: after 0206_recall_revision_actor_name, stamped later
-- than it.
--
-- Rollback: the previous release keeps working with both (the trigger only
-- clears shares nothing holds any more; the refresh does the same work or
-- less).

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_refresh_trg"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."nodes" a
              WHERE a."owner_id" = NEW."owner_id" AND a."share_level" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM "public"."nodes" n
                 WHERE n."owner_id" = NEW."owner_id" AND n."path" <@ NEW."path"
                   AND n."inherited_level" IS NOT NULL) THEN
    PERFORM "public"."mantle_refresh_inherited"(NEW."owner_id", NEW."path");
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_unshare_deleted_trg"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "public"."mantle_refresh_inherited"(OLD."owner_id", OLD."path");
  RETURN NULL;
END
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "nodes_share_deleted_after" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_share_deleted_after"
  AFTER DELETE ON "public"."nodes"
  FOR EACH ROW
  WHEN (OLD."type" = 'branch' AND OLD."share_level" IS NOT NULL)
  EXECUTE FUNCTION "public"."mantle_nodes_unshare_deleted_trg"();
