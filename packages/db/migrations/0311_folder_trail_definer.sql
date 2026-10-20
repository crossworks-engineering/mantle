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
-- only for its own login; a per-login folder only for its own login too),
-- each as id, path and title, nothing else (no data, look, slug, counts or
-- dates). Of those, only the ones the caller names:
--  - `under`: the folders one and two levels below the folder at that path
--    (a page's folders and what each of them unfolds to) that the scope does
--    not read itself (the ones it reads, it lists). When there is such a
--    folder, the rows the scope reads below `under` are read first (the
--    read_ws index), cut to those two levels, and only those folders on the
--    way are answered, so the work is the rows the scope reads there, never
--    the size of a hidden subtree; when there is none, no row is read.
--  - `paths`: the folders at those exact paths (a chain of crumbs).
--  - `folder`: the folder with that id.
-- For an exact path or an id, one probe below each named folder (the path
-- index). So the caller can ask for one page, a chain of crumbs, or one
-- folder, never a whole subtree, and a folder above nothing the scope reads
-- is never answered, whatever is named. A path the scope reads holds every
-- label of the folders above it, so what this adds is their ids and names.
-- It is for a login: no scope set (the system pool), a scope with no login
-- (a public link) or another brain answers nothing and reads no row, and
-- the caller then reads the folders it reads, as before
-- (packages/db/src/folder-trail.ts asks it only for a login's own session
-- in a workspace scope, never a key, a peer or a turn). The arguments are
-- named by the function's name (a column of the same name never changes
-- what they mean). A fixed search_path (pg_temp last), no right for
-- PUBLIC, EXECUTE for the workspace role (the write and runtime roles
-- follow it, as for 0293's definers) and the public demo's reader when it
-- exists.
--
-- No row changes. Re-runnable. The `when` sits above 0310's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_folder_trail"(owner uuid, under text, paths text[], folder uuid)
  RETURNS TABLE ("id" uuid, "path" text, "title" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  -- The gate: a scope with a login, on this brain. No row here, and nothing
  -- below reads a row.
  WITH s AS MATERIALIZED (
    SELECT "public"."mantle_scope_ws"() AS ws, "public"."mantle_scope_login_id"() AS login
     WHERE "public"."mantle_scope_active"() AND "public"."mantle_scope_login_id"() IS NOT NULL
       AND "mantle_folder_trail"."owner" = "public"."mantle_brain_id"()
  ),
  u AS MATERIALIZED (
    SELECT "mantle_folder_trail"."under"::ltree AS p, nlevel("mantle_folder_trail"."under"::ltree) AS l
      FROM s WHERE "mantle_folder_trail"."under" IS NOT NULL
  ),
  -- Below `under`: the folders one and two levels down that the scope does
  -- not read itself (a per-login folder only for its own login). With none,
  -- nothing more is read (the owner's and an Admin user's pages, and a
  -- scope that reads the folders it holds).
  cand AS MATERIALIZED (
    SELECT f."id", f."path", f."title" FROM s, u, "public"."nodes" f
     WHERE f."owner_id" = "mantle_folder_trail"."owner" AND f."type" = 'branch'
       AND f."path" ~ (u.p::text || '.*{1,2}')::lquery
       AND (f."login_id" IS NULL OR f."login_id" = s.login)
       AND NOT (f."read_ws" && s.ws)
  ),
  -- The rows the scope reads below `under`, first: the prefix test is no
  -- path index term, so they are found by the read_ws index, never by a walk
  -- of every row below `under`; each cut to the two levels below it.
  reads AS MATERIALIZED (
    SELECT DISTINCT subpath(r."path", 0, least(nlevel(r."path"), u.l + 2)) AS p
      FROM s, u, "public"."nodes" r
     WHERE EXISTS (SELECT 1 FROM cand)
       AND r."owner_id" = "mantle_folder_trail"."owner"
       AND r."read_ws" && s.ws AND (r."login_id" IS NULL OR r."login_id" = s.login)
       AND nlevel(r."path") > u.l AND subpath(r."path", 0, u.l) = u.p
  ),
  ways AS (
    SELECT x.p FROM reads x
    UNION
    SELECT subpath(x.p, 0, u.l + 1) FROM reads x, u WHERE nlevel(x.p) > u.l + 1
  ),
  below AS (
    SELECT c."id", c."path", c."title" FROM cand c WHERE c."path" IN (SELECT w.p FROM ways w)
  ),
  named AS (
    SELECT f."id", f."path", f."title", f."read_ws", f."login_id" FROM s, "public"."nodes" f
     WHERE f."owner_id" = "mantle_folder_trail"."owner" AND f."type" = 'branch'
       AND f."path" = ANY ("mantle_folder_trail"."paths"::ltree[])
    UNION
    SELECT f."id", f."path", f."title", f."read_ws", f."login_id" FROM s, "public"."nodes" f
     WHERE f."id" = "mantle_folder_trail"."folder"
       AND f."owner_id" = "mantle_folder_trail"."owner" AND f."type" = 'branch'
  ),
  probed AS (
    SELECT n."id", n."path", n."title"
      FROM s, named n
     WHERE (n."login_id" IS NULL OR n."login_id" = s.login)
       AND ((n."read_ws" && s.ws)
            -- Down the path index from the named folder (the read test is
            -- kept off the read_ws index: for a wide scope that index holds
            -- most of the brain, and a probe per named folder would read it
            -- each time).
            OR EXISTS (
              SELECT 1 FROM "public"."nodes" r
               WHERE r."owner_id" = "mantle_folder_trail"."owner" AND r."path" <@ n."path"
                 AND (r."read_ws" && s.ws) IS TRUE
                 AND (r."login_id" IS NULL OR r."login_id" = s.login)))
  )
  SELECT b."id", b."path"::text, b."title" FROM below b WHERE nlevel(b."path") > 1
  UNION
  SELECT p."id", p."path"::text, p."title" FROM probed p WHERE nlevel(p."path") > 1
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
