-- The folders above what a scope reads, as structure only (the owner's
-- rule: a login that can read an item also sees its folder and every folder
-- above it, by id, path and name; it reads nothing else of those folders,
-- sees no other item in them, and writes none of them without its own right
-- on the folder). The row rule of nodes (0242) is left as it is: a folder
-- the scope does not read stays unread by every query, and every write path
-- still finds no such folder (404). Only the tree's read paths ask this
-- definer, to name the folders on the way to what the scope reads.
--
-- mantle_folder_trail(owner, under, paths, folder): the branch rows of
-- `owner` (below a kind root, nlevel > 1) that are at or above a row the
-- scope reads (the row rule of nodes, 0242, on the scope's login as 0291's
-- definers read it: the row's read_ws meet the scope's, and a per-login row
-- only for its own login), each as id, path and title, nothing else (no
-- data, look, slug, counts or dates). Of those, only the ones the caller
-- names: the direct children of the folder at `under`, the folders at the
-- exact `paths`, and the folder with id `folder`. So the caller can ask
-- for one folder's children, a chain of crumbs, or one folder, never a
-- whole subtree in one call, and a folder above nothing the scope reads is
-- never answered, whatever is named. A path the scope reads holds every
-- label of the folders above it, so what this adds is their ids and names.
-- It is for a login: no scope set (the system pool), a scope with no login
-- (a public link) or another brain answers nothing, and the caller then
-- reads the folders it reads, as before (packages/db/src/folder-trail.ts
-- asks it only for a login's own session, never a key, a peer or a turn).
-- A fixed search_path (pg_temp last), no right for PUBLIC, EXECUTE for the
-- workspace role (the write and runtime roles follow it, as for 0293's
-- definers) and the public demo's reader when it exists.
--
-- No row changes. Re-runnable. The `when` sits above 0310's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_folder_trail"(owner uuid, under text, paths text[], folder uuid)
  RETURNS TABLE ("id" uuid, "path" text, "title" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH s AS MATERIALIZED (
    SELECT "public"."mantle_scope_ws"() AS ws, "public"."mantle_scope_login_id"() AS login
  ),
  named AS (
    SELECT f."id", f."path", f."title", f."read_ws", f."login_id" FROM "public"."nodes" f
     WHERE under IS NOT NULL AND f."owner_id" = owner AND f."type" = 'branch'
       AND f."path" <@ under::ltree AND nlevel(f."path") = nlevel(under::ltree) + 1
    UNION
    SELECT f."id", f."path", f."title", f."read_ws", f."login_id" FROM "public"."nodes" f
     WHERE f."owner_id" = owner AND f."type" = 'branch' AND f."path" = ANY (paths::ltree[])
    UNION
    SELECT f."id", f."path", f."title", f."read_ws", f."login_id" FROM "public"."nodes" f
     WHERE f."id" = folder AND f."owner_id" = owner AND f."type" = 'branch'
  )
  SELECT n."id", n."path"::text, n."title"
    FROM s, named n
   -- The gate first: no columns, so it is one check before any row is read.
   WHERE "public"."mantle_scope_active"() AND "public"."mantle_scope_login_id"() IS NOT NULL
     AND owner = "public"."mantle_brain_id"()
     AND nlevel(n."path") > 1
     AND ((n."read_ws" && s.ws AND (n."login_id" IS NULL OR n."login_id" = s.login))
          OR EXISTS (
            SELECT 1 FROM "public"."nodes" r
             WHERE r."owner_id" = owner AND r."path" <@ n."path"
               AND r."read_ws" && s.ws
               AND (r."login_id" IS NULL OR r."login_id" = s.login)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_folder_trail"(uuid, text, text[], uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_folder_trail"(uuid, text, text[], uuid) TO "mantle_view_user";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_folder_trail"(uuid, text, text[], uuid) TO demo_reader;
  END IF;
END
$$;
