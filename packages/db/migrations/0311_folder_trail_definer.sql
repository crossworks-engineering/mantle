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
--    not read itself (the ones it reads, it lists). With no such folder, no
--    other row is read. Otherwise the rows the scope reads below `under` are
--    read first (the read_ws index), at most 2000 of them: when that is all
--    of them, every such folder on the way to one is answered, at both
--    levels. When the scope reads more there (a wide scope), each such
--    folder one level down is probed down the path index instead, the
--    deepest way first, and answered with the folder below it the probe
--    went through when the scope does not read that one; a folder two levels
--    down under a folder the scope reads is probed on its own. So the work
--    is bounded by the rows the scope reads there or by the size of the
--    folders it does not read, never both. (With a wide scope a folder on
--    the way may have more folders on the way below it than are answered
--    with it; they are answered when it is opened.)
--  - `paths`: the folders at those exact paths (a chain of crumbs).
--  - `folder`: the folder with that id.
-- For an exact path or an id, one probe below each named folder (the path
-- index). The plans are made for each call (plan_cache_mode): a plan made
-- once for every scope reads a wide scope's rows for a small one. So the caller can ask for one page, a chain of crumbs, or one
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
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp
  SET plan_cache_mode = force_custom_plan AS $$
#variable_conflict use_column
DECLARE
  ws uuid[];
  who uuid;
  u ltree;
  l int;
  cand ltree[];
  n int;
  ways ltree[];
  -- Up to this many rows the scope reads below `under` are read in one go;
  -- above it each candidate is probed instead (see the header).
  cap constant int := 2000;
BEGIN
  -- The gate: a scope with a login, on this brain. Otherwise no row is read.
  IF NOT "public"."mantle_scope_active"() THEN RETURN; END IF;
  who := "public"."mantle_scope_login_id"();
  IF who IS NULL OR "mantle_folder_trail"."owner" IS DISTINCT FROM "public"."mantle_brain_id"() THEN
    RETURN;
  END IF;
  ws := "public"."mantle_scope_ws"();

  IF "mantle_folder_trail"."under" IS NOT NULL THEN
    u := "mantle_folder_trail"."under"::ltree;
    l := nlevel(u);
    -- The candidates: the folders one and two levels below `under` that the
    -- scope does not read itself (a per-login folder only for its own
    -- login). With none, nothing more is read (the owner's and an Admin
    -- user's pages, and a scope that reads the folders it holds).
    SELECT array_agg(f."path") INTO cand FROM "public"."nodes" f
     WHERE f."owner_id" = "mantle_folder_trail"."owner" AND f."type" = 'branch'
       AND f."path" <@ u AND nlevel(f."path") BETWEEN l + 1 AND l + 2
       AND (f."login_id" IS NULL OR f."login_id" = who)
       AND NOT (f."read_ws" && ws);
    IF cand IS NOT NULL THEN
      -- The rows the scope reads below `under`, at most cap + 1 of them,
      -- each cut to the two levels below it.
      SELECT count(*), array_agg(DISTINCT subpath(x."path", 0, least(nlevel(x."path"), l + 2)))
        INTO n, ways
        FROM (SELECT r."path" FROM "public"."nodes" r
               WHERE r."owner_id" = "mantle_folder_trail"."owner"
                 AND r."read_ws" && ws AND (r."login_id" IS NULL OR r."login_id" = who)
                 AND r."path" <@ u AND nlevel(r."path") > l
               LIMIT cap + 1) x;
      IF n <= cap THEN
        -- Few: every candidate on the way to one of them, at both levels.
        RETURN QUERY
          SELECT f."id", f."path"::text, f."title" FROM "public"."nodes" f
           WHERE f."owner_id" = "mantle_folder_trail"."owner" AND f."type" = 'branch'
             AND f."path" = ANY (cand) AND nlevel(f."path") > 1
             AND (f."path" = ANY (ways)
                  OR f."path" = ANY (ARRAY(SELECT subpath(w, 0, l + 1) FROM unnest(ways) w
                                            WHERE nlevel(w) > l + 1)));
      ELSE
        -- Many (a wide scope): each candidate one level below is probed down
        -- the path index, the deepest way first, so the work is the size of
        -- the folders the scope does not read, never the rows it reads. Such
        -- a folder on the way is answered with the folder below it that the
        -- probe went through, when the scope does not read that one (so it
        -- unfolds; the other folders on the way below it are answered when
        -- it is opened). A candidate two levels down under a folder the
        -- scope reads is probed on its own.
        RETURN QUERY
          WITH c AS MATERIALIZED (
            SELECT f."id", f."path", f."title" FROM "public"."nodes" f
             WHERE f."owner_id" = "mantle_folder_trail"."owner" AND f."type" = 'branch'
               AND f."path" = ANY (cand)
          ),
          one AS MATERIALIZED (
            SELECT c."id", c."path", c."title",
                   (SELECT r."path" FROM "public"."nodes" r
                     WHERE r."owner_id" = "mantle_folder_trail"."owner" AND r."path" <@ c."path"
                       AND nlevel(r."path") > l + 1
                       AND (r."read_ws" && ws) IS TRUE
                       AND (r."login_id" IS NULL OR r."login_id" = who)
                     LIMIT 1) AS deep
              FROM c WHERE nlevel(c."path") = l + 1
          ),
          way AS MATERIALIZED (
            SELECT o."id", o."path", o."title", o."deep" FROM one o
             WHERE o."deep" IS NOT NULL
                OR EXISTS (SELECT 1 FROM "public"."nodes" r
                            WHERE r."owner_id" = "mantle_folder_trail"."owner" AND r."path" = o."path"
                              AND (r."read_ws" && ws) IS TRUE
                              AND (r."login_id" IS NULL OR r."login_id" = who))
          )
          SELECT w."id", w."path"::text, w."title" FROM way w WHERE nlevel(w."path") > 1
          UNION
          SELECT c."id", c."path"::text, c."title" FROM c, way w
           WHERE nlevel(c."path") = l + 2 AND c."path" = subpath(w."deep", 0, l + 2)
          UNION
          SELECT c."id", c."path"::text, c."title" FROM c
           WHERE nlevel(c."path") = l + 2
             AND NOT (subpath(c."path", 0, l + 1) = ANY (cand))
             AND EXISTS (SELECT 1 FROM "public"."nodes" r
                          WHERE r."owner_id" = "mantle_folder_trail"."owner" AND r."path" <@ c."path"
                            AND (r."read_ws" && ws) IS TRUE
                            AND (r."login_id" IS NULL OR r."login_id" = who));
      END IF;
    END IF;
  END IF;

  IF coalesce(cardinality("mantle_folder_trail"."paths"), 0) > 0 OR "mantle_folder_trail"."folder" IS NOT NULL THEN
    -- Exact paths and an id: a folder the scope reads itself counts (it is a
    -- row at that folder); otherwise one probe below it, down the path index
    -- (the read test is kept off the read_ws index: for a wide scope that
    -- index holds most of the brain, and a probe per named folder would read
    -- it each time).
    RETURN QUERY
      WITH named AS (
        SELECT f."id", f."path", f."title", f."read_ws", f."login_id" FROM "public"."nodes" f
         WHERE f."owner_id" = "mantle_folder_trail"."owner" AND f."type" = 'branch'
           AND f."path" = ANY ("mantle_folder_trail"."paths"::ltree[])
        UNION
        SELECT f."id", f."path", f."title", f."read_ws", f."login_id" FROM "public"."nodes" f
         WHERE f."id" = "mantle_folder_trail"."folder"
           AND f."owner_id" = "mantle_folder_trail"."owner" AND f."type" = 'branch'
      )
      SELECT n."id", n."path"::text, n."title" FROM named n
       WHERE nlevel(n."path") > 1
         AND (n."login_id" IS NULL OR n."login_id" = who)
         AND ((n."read_ws" && ws)
              OR EXISTS (
                SELECT 1 FROM "public"."nodes" r
                 WHERE r."owner_id" = "mantle_folder_trail"."owner" AND r."path" <@ n."path"
                   AND (r."read_ws" && ws) IS TRUE
                   AND (r."login_id" IS NULL OR r."login_id" = who)));
  END IF;
END
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
