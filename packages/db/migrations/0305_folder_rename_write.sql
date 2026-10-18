-- S11a-6a (docs/_archive/tree-bugs-handover.md): a member with Write on a
-- folder was refused its rename (tree_folder_update, folder_rename), in
-- every check mode on the write role. The owner's rule (2026-10-18): Write
-- on a folder allows its rename; its move, its indexing switch, its delete
-- and its grants stay a Moderator's of its home (manage).
--
-- The cause: a rename rewrites the folder's subtree path, and both checks of
-- a path change asked manage of the folder, for a rename as for a move:
--  - mantle_subtree_rewrite (0282) asked manage of the folder's home of a
--    write-role caller before it rewrote anything;
--  - the move check (mantle_nodes_acl_path_trg, 0279's body) asked
--    mantle_may_manage of each moved root, and edit of the folder it sits
--    in ("add items to that folder"), whether the root changed folder or
--    only its own label.
--
-- The fix, a rename only: the same owner, a folder (type branch), the same
-- parent path and depth, and not a system folder (data.system: its name is
-- fixed, the tree refuses it for everyone; the database keeps asking
-- manage of it, as before):
--  1. mantle_moved_nodes notes each moved row's old path and whether it
--     was a system folder (mantle_nodes_moved_row_trg, from OLD), so the
--     statement check tells a rename from a move by the row's own old and
--     new path, never by a setting a session could set, and one UPDATE that
--     changes the path and clears data.system is still a system folder's
--     (system before or after: manage).
--  2. The move check asks edit of a renamed folder (mantle_may_edit of its
--     home and Write grants) instead of manage, and no longer asks edit of
--     the folder it sits in: a rename adds nothing to that folder. Every
--     other moved root (a move, a re-own, an item, a system folder) is
--     asked exactly as before.
--  3. mantle_subtree_rewrite asks edit of the folder for a rename by a
--     write-role caller (manage for a move or a system folder, as before).
--     What a rename carries along (rows the caller does not read too: filing
--     is not editing, 0282) is unchanged.
-- The item check of each row (the write check, the edit check) is
-- untouched: the folder's own title and slug are still an edit of it.
--
-- Re-runnable. The ADD COLUMN takes mantle_moved_nodes' ACCESS EXCLUSIVE
-- lock, which a transaction moving nodes holds a row lock against until it
-- ends: the migration waits at most 30 s, fails, and is safe to run again.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."mantle_moved_nodes" ADD COLUMN IF NOT EXISTS "old_path" ltree;
--> statement-breakpoint
ALTER TABLE "public"."mantle_moved_nodes" ADD COLUMN IF NOT EXISTS "old_system" boolean;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_moved_row_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  -- A row moved twice in one statement keeps where it came from.
  INSERT INTO "public"."mantle_moved_nodes" ("xid", "id", "old_owner", "old_path", "old_system")
    VALUES (pg_current_xact_id(), NEW."id", OLD."owner_id", OLD."path",
            coalesce((OLD."data" ->> 'system') = 'true', false)) ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_moved_row_trg"() FROM PUBLIC;
--> statement-breakpoint

-- A folder's rename (the rule of 1 to 3 above): the same owner, the same
-- parent path and depth, a folder that was no system folder and is none
-- (`was_system`: the row before the write; `d`: its data after). No role
-- may run it.
CREATE OR REPLACE FUNCTION "public"."mantle_is_folder_rename"(
  old_owner uuid, old_path ltree, new_owner uuid, new_path ltree, t "public"."node_type",
  was_system boolean, d jsonb)
  RETURNS boolean LANGUAGE sql IMMUTABLE
  SET search_path = "public", pg_temp AS $$
  SELECT coalesce(
    t = 'branch'
    AND old_owner = new_owner
    AND nlevel(old_path) = nlevel(new_path)
    AND subpath(old_path, 0, nlevel(old_path) - 1) = subpath(new_path, 0, nlevel(new_path) - 1)
    AND NOT coalesce(was_system, true)
    AND NOT coalesce((d ->> 'system') = 'true', false),
    false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_is_folder_rename"(uuid, ltree, uuid, ltree, "public"."node_type", boolean, jsonb) FROM PUBLIC;
--> statement-breakpoint

-- The move check, 0279's body with the rename branch (2 above).
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_path_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  me xid8;
  moved uuid[];
  strict_ids uuid[];
  roots uuid[];
  renamed uuid[];
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
      RETURNING t."id", t."old_owner", t."old_path", t."old_system"
  ), classed AS (
    SELECT tk."id",
           coalesce((SELECT s."kind" = 'personal' FROM "public"."spaces" s
                      WHERE s."id" = tk."old_owner"), false) AS was_personal,
           coalesce((SELECT s."kind" = 'personal' FROM "public"."nodes" n
                       JOIN "public"."spaces" s ON s."id" = n."owner_id"
                      WHERE n."id" = tk."id"), false) AS is_personal,
           coalesce((SELECT "public"."mantle_is_folder_rename"(
                              tk."old_owner", tk."old_path", n."owner_id", n."path", n."type",
                              tk."old_system", n."data")
                       FROM "public"."nodes" n WHERE n."id" = tk."id"), false) AS is_rename
      FROM taken tk
  )
  SELECT coalesce(array_agg("id"), '{}'::uuid[]),
         coalesce(array_agg("id") FILTER (WHERE NOT (was_personal AND is_personal)), '{}'::uuid[]),
         coalesce(array_agg("id") FILTER (WHERE is_rename), '{}'::uuid[])
    INTO moved, strict_ids, renamed
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
      SELECT n."id", n."type", n."home_ws", n."write_ws", n."read_ws", pf."id" AS folder,
             pf."home_ws" AS f_home, pf."write_ws" AS f_write, pf."read_ws" AS f_read
        FROM "public"."nodes" n
        LEFT JOIN "public"."nodes" pf
          ON pf."owner_id" = n."owner_id" AND pf."type" = 'branch'
         AND pf."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
       WHERE n."id" = ANY (roots)
    LOOP
      IF m."id" = ANY (renamed) THEN
        -- A folder's rename: Write on it (S11a-6a). It stays in its folder.
        IF NOT coalesce("public"."mantle_may_edit"(m."home_ws", m."write_ws"), false) THEN
          RAISE EXCEPTION 'not allowed to edit this item' USING ERRCODE = '42501';
        END IF;
        CONTINUE;
      END IF;
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
--> statement-breakpoint

-- 0282's body, a rename asking edit of the folder (3 above).
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
  SELECT x."id", x."home_ws", x."write_ws", x."read_ws", x."type", x."data" INTO f
    FROM "public"."nodes" x
   WHERE x."owner_id" = o AND x."type" = 'branch' AND x."path" = old_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mantle_subtree_rewrite: no folder at that path' USING ERRCODE = '22023';
  END IF;
  IF "public"."mantle_caller_is_write_role"() THEN
    IF NOT "public"."mantle_scope_active"()
       OR NOT "public"."mantle_check_row"(f."home_ws", f."write_ws", f."read_ws",
                CASE WHEN "public"."mantle_is_folder_rename"(o, old_path, o, new_path, f."type",
                                                             coalesce((f."data" ->> 'system') = 'true', false),
                                                             f."data")
                     THEN 'edit' ELSE 'manage' END) THEN
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
  -- The apps inside a moved folder (0282, 3): staged, and skipped off.
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
