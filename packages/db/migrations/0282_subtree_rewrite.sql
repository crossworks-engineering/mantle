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
--    scoped limited caller (the write role, or the workspace role a login's
--    reads run on) does not read; 0 for any other caller.
--    mantle_subtree_refuse_hidden(owner, path) refuses (42501, detail
--    hidden_rows: the HTTP mapper answers 409, "This folder holds items you
--    cannot move.") when there is one: the ONE rule, called by the rewrite
--    for a move and by both folder deletes (node-ops.ts, files-merge.ts).
-- 3. The move check (0245, 0279's body) also holds every app inside a moved
--    folder to the placement rule its root has (a new holder needs a
--    Moderator of it), through the edit check's gate: off as before, warn
--    reports, on refuses. Before, only an app moved itself was checked.
--
-- None of 1 and 2 is staged by mantle.edit_check: they fix what the write
-- role did wrong (orphans), on any box where login writes run on it.
--
-- Re-runnable.

-- Whether the statement's caller is a scoped limited role: the write role or
-- the workspace role (a login's reads), by the session or the `role`
-- setting (inside a definer current_user is the owner).
CREATE OR REPLACE FUNCTION "public"."mantle_caller_is_scoped_role"()
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT session_user IN ('mantle_write_user', 'mantle_view_user')
      OR coalesce(current_setting('role', true), '') IN ('mantle_write_user', 'mantle_view_user')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_caller_is_scoped_role"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_subtree_hidden"(o uuid, p ltree)
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE WHEN NOT "public"."mantle_caller_is_scoped_role"() THEN 0
              ELSE (SELECT count(*)::int FROM "public"."nodes" x
                     WHERE x."owner_id" = o AND x."path" <@ p
                       AND NOT "public"."mantle_check_row"(x."home_ws", x."write_ws", x."read_ws", 'read'))
         END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_subtree_hidden"(uuid, ltree) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_subtree_hidden"(uuid, ltree) TO "mantle_view_user";
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
GRANT EXECUTE ON FUNCTION "public"."mantle_subtree_refuse_hidden"(uuid, ltree) TO "mantle_view_user";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_subtree_rewrite"(o uuid, old_path ltree, new_path ltree)
  RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  f record;
  hidden uuid[];
  n integer;
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
    -- A move (a new parent) with rows the caller cannot read: refused (the
    -- owner's rule). A rename takes them along.
    IF "public"."mantle_parent_folder_path"('branch', old_path)
         IS DISTINCT FROM "public"."mantle_parent_folder_path"('branch', new_path) THEN
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
-- 3. The move check (0279's body), every app inside a moved folder held to
--    the placement rule.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_path_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  me xid8;
  moved uuid[];
  strict_ids uuid[];
  roots uuid[];
  folders uuid[];
  held uuid[];
  missing uuid;
  m record;
  root uuid;
BEGIN
  me := pg_current_xact_id_if_assigned();
  IF me IS NULL THEN RETURN NULL; END IF;
  WITH taken AS (
    DELETE FROM "public"."mantle_moved_nodes" t WHERE t."xid" = me
      RETURNING t."id", t."old_owner"
  ), classed AS (
    SELECT tk."id",
           coalesce((SELECT s."kind" = 'personal' FROM "public"."spaces" s
                      WHERE s."id" = tk."old_owner"), false) AS was_personal,
           coalesce((SELECT s."kind" = 'personal' FROM "public"."nodes" n
                       JOIN "public"."spaces" s ON s."id" = n."owner_id"
                      WHERE n."id" = tk."id"), false) AS is_personal
      FROM taken tk
  )
  SELECT coalesce(array_agg("id"), '{}'::uuid[]),
         coalesce(array_agg("id") FILTER (WHERE NOT (was_personal AND is_personal)), '{}'::uuid[])
    INTO moved, strict_ids
    FROM classed;
  IF cardinality(moved) = 0 THEN RETURN NULL; END IF;

  SELECT coalesce(array_agg(n."id"), '{}'::uuid[]),
         coalesce(array_agg(DISTINCT pf."id") FILTER (WHERE pf."id" IS NOT NULL), '{}'::uuid[])
    INTO roots, folders
    FROM "public"."nodes" n
    LEFT JOIN "public"."nodes" pf
      ON pf."owner_id" = n."owner_id" AND pf."type" = 'branch'
     AND pf."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
   WHERE n."id" = ANY (moved)
     AND (pf."id" IS NULL OR NOT (pf."id" = ANY (moved)));

  -- Fix 1: a row that was or is a brain row needs its head held for update,
  -- wherever it lands. No personal-space exemption for it (0244 rule 1 reads
  -- the owner after the update, which is the hole this closes).
  IF cardinality(strict_ids) > 0 AND "public"."mantle_heads_check_mode"() <> 'off' THEN
    held := "public"."mantle_heads_held"(true);
    SELECT d.x INTO missing
      FROM (SELECT u.x FROM unnest(strict_ids) AS u(x)
            EXCEPT
            SELECT h.x FROM unnest(held) AS h(x)) d
     LIMIT 1;
    IF missing IS NOT NULL THEN
      PERFORM "public"."mantle_heads_miss"('nodes_move', missing, 'head not locked first for update');
    END IF;
  END IF;
  PERFORM "public"."mantle_heads_require"(folders, 'nodes_move_folder');

  IF "public"."mantle_scope_active"() THEN
    FOR m IN
      SELECT n."id", n."type", n."home_ws", n."read_ws", pf."id" AS folder,
             pf."home_ws" AS f_home, pf."write_ws" AS f_write, pf."read_ws" AS f_read
        FROM "public"."nodes" n
        LEFT JOIN "public"."nodes" pf
          ON pf."owner_id" = n."owner_id" AND pf."type" = 'branch'
         AND pf."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
       WHERE n."id" = ANY (roots)
    LOOP
      IF NOT "public"."mantle_may_manage"(m."home_ws") THEN
        RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501';
      END IF;
      IF m.folder IS NOT NULL AND NOT "public"."mantle_may_edit"(m.f_home, m.f_write) THEN
        RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
      END IF;
      IF m."type" = 'app' AND m.folder IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(m.f_read) AS w
                      WHERE NOT (w = ANY (m."read_ws"))
                        AND NOT (w = ANY ("public"."mantle_scope_mod_ws"()))) THEN
        RAISE EXCEPTION 'placing this app adds a workspace you do not moderate' USING ERRCODE = '42501';
      END IF;
      -- Every app inside a moved folder meets the same rule (fix round 2):
      -- the destination's workspaces reach it too. Through the edit check's
      -- gate: off as before (only the root was checked), warn reports, on
      -- refuses.
      IF m."type" = 'branch' AND m.folder IS NOT NULL
         AND EXISTS (SELECT 1 FROM "public"."nodes" a
                      WHERE a."owner_id" = (SELECT x."owner_id" FROM "public"."nodes" x WHERE x."id" = m."id")
                        AND a."type" = 'app'
                        AND a."path" <@ (SELECT x."path" FROM "public"."nodes" x WHERE x."id" = m."id")
                        AND EXISTS (SELECT 1 FROM unnest(m.f_read) AS w
                                     WHERE NOT (w = ANY (a."read_ws"))
                                       AND NOT (w = ANY ("public"."mantle_scope_mod_ws"())))) THEN
        PERFORM "public"."mantle_edit_refuse"(
          'UPDATE on nodes: a move adds a workspace to an app inside it, not moderated', 'no_edit',
          'placing this app adds a workspace you do not moderate');
      END IF;
    END LOOP;
  END IF;

  FOREACH root IN ARRAY roots LOOP
    PERFORM "public"."mantle_rederive_subtree"(root, true);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_acl_path_trg"() FROM PUBLIC;
