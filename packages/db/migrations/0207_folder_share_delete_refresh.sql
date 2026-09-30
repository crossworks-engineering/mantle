-- The item tree: a deleted shared folder never leaves its share behind, and
-- the share refresh skips work on brains that share nothing, and a share
-- change cannot race an insert (folder audit 2026-09-30, X1, P5 and Y1;
-- docs/folder-tree.md, "Sharing a folder").
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
-- 3. An unshare (or a share, or a folder move) racing an insert into the
--    same folder could leave the new row at the old share: each side read
--    the other's work under its own snapshot, so the insert computed the
--    share still set and the refresh could not see the uncommitted row.
--    Fails OPEN (folder audit Y1). Now every write that files a workspace
--    row under a SHAREABLE root (files, notes, pages, draw, tables,
--    formulas, apps: the roots nodes_share_level_ck allows; nothing else
--    can inherit a share, so email, tasks and the rest never wait) takes a
--    SHARED advisory lock on its owner before it reads the shares above
--    it, and every refresh (a folder's path or share changed, a shared
--    folder deleted) takes it EXCLUSIVE first. The two wait for each
--    other, and each reads with a fresh snapshot once it holds the lock
--    (plpgsql statements in READ COMMITTED), so neither misses the other's
--    committed work. Lock order is always advisory, then rows: writers that
--    change shares or folder paths take the exclusive lock as the first
--    statement of their transaction (mantle_share_write_lock), and writers
--    that MOVE existing rows take the shared lock first too (an UPDATE
--    locks its row before this trigger runs, so the trigger's own request
--    would come too late). Both set a lock_timeout; a wait past it is a
--    "busy, try again" refusal, never a hang.
--    The nightly share-drift sweep (maintenance registry) repairs and
--    reports anything that slips through anyway.
--
-- Number and order: after 0206_recall_revision_actor_name, stamped later
-- than it.
--
-- Rollback: the previous release keeps working with both (the trigger only
-- clears shares nothing holds any more; the refresh does the same work or
-- less).

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- The advisory lock key for one owner's shares.
CREATE OR REPLACE FUNCTION "public"."mantle_share_lock_key"(o uuid)
  RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT hashtextextended('mantle-share:' || o::text, 0)
$$;
--> statement-breakpoint

-- Taken by a writer that is about to change shares or folder paths, at the
-- start of its transaction (before any row lock), so the triggers' own
-- requests in that transaction never wait on anything but other writers.
CREATE OR REPLACE FUNCTION "public"."mantle_share_write_lock"(o uuid)
  RETURNS void LANGUAGE sql VOLATILE AS $$
  SELECT pg_advisory_xact_lock("public"."mantle_share_lock_key"(o))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_inherit_trg"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF "public"."mantle_workspace_kind"(NEW."type") AND nlevel(NEW."path") > 1
     AND subpath(NEW."path", 0, 1)::text IN
         ('files', 'notes', 'pages', 'draw', 'tables', 'formulas', 'apps') THEN
    PERFORM pg_advisory_xact_lock_shared("public"."mantle_share_lock_key"(NEW."owner_id"));
  END IF;
  NEW."inherited_level" := "public"."mantle_inherited_level"(NEW."owner_id", NEW."path", NEW."type");
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_refresh_trg"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock("public"."mantle_share_lock_key"(NEW."owner_id"));
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
  PERFORM pg_advisory_xact_lock("public"."mantle_share_lock_key"(OLD."owner_id"));
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
