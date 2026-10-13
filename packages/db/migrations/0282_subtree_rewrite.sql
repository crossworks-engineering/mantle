-- Workspaces arch A3a fix round 1 (docs/edit-check.md, "Folders"): a
-- folder's rename or move, and its delete, on the write role.
--
-- The write role's row rules let a login's UPDATE touch only the rows its
-- scope reads. A folder's rename or move rewrites the path of everything
-- below it in one UPDATE, so a child the mover cannot read (homed elsewhere,
-- its grant "Removed here") kept its old path: an orphan under a folder
-- that is no longer there. And the heads filter (0280) drops that child's
-- head too.
--
-- 1. mantle_subtree_rewrite(owner, old_path, new_path): the one place a
--    folder's subtree takes its new path, as its owner (every row below the
--    folder moves, read or not; filing is not editing). For a write-role
--    caller it first asks manage of the folder's home (the move check of
--    0245 asks the same of the folder in every mode; here before any lock)
--    and then takes the heads of the rows the scope does not read
--    (mantle_lock_heads_more_core: what the heads filter dropped). The move
--    check (mantle_nodes_acl_path_trg) still runs on the folder row, with
--    the caller's scope. A write-role caller with no scope is refused. Any
--    other caller (the system pool) moves as before.
--    The owner's rule (fix round 2): a MOVE (a new parent) of a folder that
--    holds rows the caller cannot read is refused (409); a RENAME (the same
--    parent, no grant change) moves them with it.
-- 2. mantle_subtree_hidden(owner, path): how many rows below `path` a
--    write-role caller does not read; 0 for any other caller (the system
--    pool, so a box whose actor check is off is never refused). No role
--    may run it. mantle_subtree_refuse_hidden(owner, path) refuses (42501,
--    detail hidden_rows: the HTTP mapper answers 409, the tools say "This
--    folder holds items you cannot move.") when there is one: the ONE rule,
--    called by the rewrite for a move and by every folder delete (node-ops.ts,
--    files-merge.ts, files ops/folders.ts), always inside a write
--    transaction (the login write gateway: the write role in warn and on,
--    the system pool when off).
-- 3. A folder MOVE (a new parent) holds every app inside it to the placement
--    rule (a workspace the destination adds needs a Moderator of it), as
--    the move check (0245) holds an app moved itself; a workspace the app
--    or a folder between it and the moved folder has "Removed here" is not
--    added and does not count. A rename asks nothing. Through the edit
--    check's gate (off: not even computed, warn reports, on refuses), with
--    a scope set (any session, as the move check).
--
-- 1 and 2 are not staged by mantle.edit_check: they fix what the write role
-- did wrong (orphans), on any box where login writes run on it (its actor
-- check warn or on). On a box whose actor check is off nothing changes.
--
-- Re-runnable.

CREATE OR REPLACE FUNCTION "public"."mantle_subtree_hidden"(o uuid, p ltree)
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE WHEN NOT "public"."mantle_caller_is_write_role"() THEN 0
              ELSE (SELECT count(*)::int FROM "public"."nodes" x
                     WHERE x."owner_id" = o AND x."path" <@ p
                       AND NOT "public"."mantle_check_row"(x."home_ws", x."write_ws", x."read_ws", 'read'))
         END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_subtree_hidden"(uuid, ltree) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_subtree_refuse_hidden"(o uuid, p ltree)
  RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF "public"."mantle_subtree_hidden"(o, p) > 0 THEN
    RAISE EXCEPTION 'This folder holds items you cannot move.'
      USING ERRCODE = '42501', DETAIL = 'hidden_rows';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_subtree_refuse_hidden"(uuid, ltree) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_subtree_rewrite"(o uuid, old_path ltree, new_path ltree)
  RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  f record;
  hidden uuid[];
  dest_read uuid[];
  n integer;
  -- A rename keeps the parent: the same depth and the same path above it.
  moving boolean := nlevel(old_path) <> nlevel(new_path)
                    OR subpath(old_path, 0, nlevel(old_path) - 1)
                       IS DISTINCT FROM subpath(new_path, 0, nlevel(new_path) - 1);
BEGIN
  SELECT x."id", x."home_ws", x."write_ws", x."read_ws" INTO f
    FROM "public"."nodes" x
   WHERE x."owner_id" = o AND x."type" = 'branch' AND x."path" = old_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mantle_subtree_rewrite: no folder at that path' USING ERRCODE = '22023';
  END IF;
  IF "public"."mantle_caller_is_write_role"() THEN
    IF NOT "public"."mantle_scope_active"()
       OR NOT "public"."mantle_check_row"(f."home_ws", f."write_ws", f."read_ws", 'manage') THEN
      RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501', DETAIL = 'no_edit';
    END IF;
    -- A move with rows the caller cannot read: refused (the owner's rule).
    -- A rename takes them along.
    IF moving THEN
      PERFORM "public"."mantle_subtree_refuse_hidden"(o, old_path);
    END IF;
    SELECT array_agg(x."id" ORDER BY x."id") INTO hidden
      FROM "public"."nodes" x
     WHERE x."owner_id" = o AND x."path" <@ old_path
       AND NOT "public"."mantle_check_row"(x."home_ws", x."write_ws", x."read_ws", 'read');
    IF hidden IS NOT NULL AND "public"."mantle_heads_taken"() THEN
      PERFORM "public"."mantle_lock_heads_more_core"(hidden);
    END IF;
  END IF;
  -- The apps inside a moved folder (3 above): staged, and skipped off.
  IF moving AND "public"."mantle_scope_active"() AND "public"."mantle_edit_check_mode"() <> 'off' THEN
    -- The folder it lands in, as the re-derive finds it: none at a tree's
    -- top level (a kind's root row passes no grants), so nothing is added.
    SELECT p."read_ws" INTO dest_read FROM "public"."nodes" p
     WHERE p."owner_id" = o AND p."type" = 'branch'
       AND p."path" = "public"."mantle_parent_folder_path"('branch', new_path);
    IF FOUND AND EXISTS (
      SELECT 1 FROM "public"."nodes" a, unnest(dest_read) AS w
       WHERE a."owner_id" = o AND a."type" = 'app' AND a."path" <@ old_path
         AND NOT (w = ANY (a."read_ws"))
         AND NOT (w = ANY ("public"."mantle_scope_mod_ws"()))
         AND NOT EXISTS (
           SELECT 1 FROM "public"."item_grants" g
             JOIN "public"."nodes" c ON c."id" = g."node_id"
            WHERE g."workspace_id" = w AND g."excluded"
              AND c."owner_id" = o AND c."path" <@ old_path
              AND (c."id" = a."id" OR (c."type" = 'branch' AND a."path" <@ c."path")))) THEN
      PERFORM "public"."mantle_edit_refuse"(
        'UPDATE on nodes: a move adds a workspace to an app inside it, not moderated', 'no_edit',
        'placing this app adds a workspace you do not moderate');
    END IF;
  END IF;
  UPDATE "public"."nodes"
     SET "path" = CASE WHEN "path" = old_path THEN new_path
                       ELSE (new_path || subpath("path", nlevel(old_path)))::ltree END
   WHERE "owner_id" = o AND "path" <@ old_path;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_subtree_rewrite"(uuid, ltree, ltree) FROM PUBLIC;
--> statement-breakpoint
-- An earlier, unreleased build of this file granted these to the workspace
-- role and had a helper for it (test databases only): taken back.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mantle_view_user') THEN
    REVOKE ALL ON FUNCTION "public"."mantle_subtree_hidden"(uuid, ltree) FROM "mantle_view_user";
    REVOKE ALL ON FUNCTION "public"."mantle_subtree_refuse_hidden"(uuid, ltree) FROM "mantle_view_user";
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_caller_is_scoped_role"();
