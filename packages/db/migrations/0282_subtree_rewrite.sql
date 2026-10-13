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
-- 2. mantle_subtree_hidden(owner, path): how many rows below `path` a
--    write-role caller's scope does not read (0 for any other caller). A
--    folder delete that would leave such rows behind is refused by the app
--    (node-ops.ts: 409) instead of orphaning them.
--
-- Re-runnable.

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
