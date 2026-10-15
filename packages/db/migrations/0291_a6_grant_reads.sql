-- Arch A6 round 2 (plan v2 page fcc4aee4: "the reads of grants.ts,
-- workspaces.ts, link-serve.ts, member-apps.ts and tree/visibility.ts move
-- into scope"): the Grant Access panel and the workspace screens read in the
-- caller's own scope (the workspace role, its row rules), no longer on the
-- system pool. Where an answer needs rows outside the caller's scope (an
-- Admin user naming every workspace, a manager seeing the rows of
-- workspaces it is not in, the counts of a folder that holds items the
-- caller cannot open), a definer here returns exactly that answer.
--
-- Every definer below: a fixed search_path, no right for PUBLIC, EXECUTE
-- for the workspace role (and so the write role, which mirrors its
-- function rights: applyViewerGrants), and the public demo's SELECT-only
-- reader when it exists (it serves owner reads, as 0285 and 0286 granted
-- theirs). Each one holds itself to the caller's scope when a scope is set
-- (mantle.ws): the item must be one the scope reads, the workspace one of
-- the scope's, and an "everything" answer only for a scope whose login
-- holds the users area (mantle_scope_has_area). With no scope set (the
-- system pool: an Admin user's write request, a worker) it answers as the
-- system pool always read.
--
-- 1. mantle_grant_refuses (0279): a grant change the rule refuses is
--    refused in every check mode while a scope is set. Until now the write
--    role in warn (and off) only reported it and let it run, so warn
--    enforced less than off, where the system pool with the scope refuses
--    (A8 matrix, F7 b). The miss is still reported as before.
-- 2. mantle_item_grants(node): the grant rows of an item the scope reads,
--    with each workspace's name. Every row not "Removed here" (any reader
--    of the item may name the workspaces holding it: mantle_ws_names, 0279);
--    a "Removed here" row of a workspace outside the scope only for a
--    manager of the item or the users area (the panel shows those rows to
--    them only). With each row: whether its workspace is archived, whether
--    the item's folder passes that workspace on (`derivable`: the folder's
--    row, not removed there, for a kind that may take it), and the folder.
-- 3. mantle_grant_counts(node, add_ws, remove_ws, mine): the counts of a
--    grant change on an item or a folder's subtree (the preview, and the
--    size limit of a folder change): every item, what would gain add_ws,
--    the apps among them, what would lose remove_ws, the items the caller
--    cannot open (`mine`: the caller's workspaces, used only with no scope
--    set; in a scope, the scope's), an app's exported tables. Only the
--    change's own rule may ask: add needs manage of the item and a
--    Moderator of add_ws; remove manage or a Moderator of remove_ws; the
--    size alone manage or a Moderator of a workspace holding the item.
-- 4. mantle_item_embeds(node): what an item the scope reads embeds (the
--    node_embeds rows, which the workspace role does not read), and what
--    the drawings it embeds embed in turn (`hop`), with each target's kind.
-- 5. mantle_ws_seen(login): the workspaces `login` may see, as the
--    workspace screens list them (its live ones; every one for the users
--    area), with their user and resource counts, its own seat, the
--    assistant (and whether it has history) and the landing app (held,
--    ready; its title only to a user of the workspace). In a scope only for
--    the scope's own login.
-- 6. mantle_ws_people(ws), mantle_ws_resource_rows(ws): a workspace's users
--    (name, email, the Moderator tick, who added them) and resources (with
--    their names), for a user of it or the users area.
-- 7. mantle_ws_item_counts(ws): a workspace's homes, grants and "Removed
--    here" rows (the archive preview), for a Moderator of it or the users
--    area.
-- 8. mantle_ws_login_search(term, lim, off): logins by name or email for
--    the user search: the users area, any term, any page; a Moderator of a
--    workspace, at least 3 characters, 10 at most, the first page only.
--
-- No table, no row, no trigger and no LLM work changes. Re-runnable:
-- CREATE OR REPLACE only.

CREATE OR REPLACE FUNCTION "public"."mantle_grant_refuses"(ok boolean, what text, message text)
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NOT ok AND "public"."mantle_scope_active"() THEN
    -- Reported as before (the write role's miss in off and warn); refused
    -- in every mode.
    PERFORM "public"."mantle_scoped_write_refuses"(what);
    RAISE EXCEPTION '%', message USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_grant_refuses"(boolean, text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_item_grants"(node uuid)
  RETURNS TABLE ("workspace_id" uuid, "name" text, "write" boolean, "is_home" boolean,
                 "via_folder_id" uuid, "excluded" boolean, "archived" boolean,
                 "derivable" boolean, "parent_folder" uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH i AS (
    SELECT n."id", n."type",
           "public"."mantle_parent_folder"(n."owner_id", n."type", n."path") AS parent,
           (NOT "public"."mantle_scope_active"()
            OR coalesce("public"."mantle_may_manage"(n."home_ws"), false)
            OR "public"."mantle_scope_has_area"('users')) AS wide
      FROM "public"."nodes" n
     WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"()
       AND (NOT "public"."mantle_scope_active"()
            OR (n."read_ws" && "public"."mantle_scope_ws"()
                AND (n."login_id" IS NULL OR n."login_id" = "public"."mantle_login_id"())))
  )
  SELECT g."workspace_id", w."name", g."write", g."is_home", g."via_folder_id", g."excluded",
         w."archived_at" IS NOT NULL,
         (i.parent IS NOT NULL
          AND EXISTS (SELECT 1 FROM "public"."item_grants" fg
                       WHERE fg."node_id" = i.parent AND fg."workspace_id" = g."workspace_id"
                         AND NOT fg."excluded")
          AND "public"."mantle_grant_kind_ok"(i."type", g."workspace_id", true)),
         i.parent
    FROM i
    JOIN "public"."item_grants" g ON g."node_id" = i."id"
    JOIN "public"."workspaces" w ON w."id" = g."workspace_id"
   WHERE NOT g."excluded" OR i.wide OR g."workspace_id" = ANY ("public"."mantle_scope_ws"())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_item_grants"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_item_grants"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_grant_counts"(
  node uuid, add_ws uuid, remove_ws uuid, mine uuid[])
  RETURNS TABLE ("total" integer, "gain" integer, "gain_apps" integer, "lose" integer,
                 "hidden" integer, "exports" integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH x AS (
    SELECT n."id", n."owner_id", n."path", n."type",
           CASE WHEN "public"."mantle_scope_active"() THEN "public"."mantle_scope_ws"()
                ELSE coalesce(mine, '{}'::uuid[]) END AS ws
      FROM "public"."nodes" n
     WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"()
       AND (NOT "public"."mantle_scope_active"()
            OR (n."read_ws" && "public"."mantle_scope_ws"()
                AND (n."login_id" IS NULL OR n."login_id" = "public"."mantle_login_id"())
                AND (add_ws IS NULL
                     OR (coalesce("public"."mantle_may_manage"(n."home_ws"), false)
                         AND add_ws = ANY ("public"."mantle_scope_mod_ws"())))
                AND (remove_ws IS NULL
                     OR coalesce("public"."mantle_may_manage"(n."home_ws"), false)
                     OR remove_ws = ANY ("public"."mantle_scope_mod_ws"()))
                AND (add_ws IS NOT NULL OR remove_ws IS NOT NULL
                     OR coalesce("public"."mantle_may_manage"(n."home_ws"), false)
                     OR n."read_ws" && "public"."mantle_scope_mod_ws"())))
  ),
  sub AS (
    SELECT d."id", d."type", d."path", d."read_ws" FROM "public"."nodes" d, x
     WHERE d."owner_id" = x."owner_id"
       AND (d."id" = x."id" OR (x."type" = 'branch' AND d."path" <@ x."path"))
  )
  SELECT
    CASE WHEN x."type" = 'branch' AND x."path" IS NOT NULL
         THEN (SELECT count(*)::int FROM "public"."nodes" t
                WHERE t."owner_id" = x."owner_id" AND t."path" <@ x."path")
         ELSE 1 END,
    CASE WHEN add_ws IS NULL THEN 0 ELSE (
      SELECT count(*)::int FROM sub d
       WHERE NOT EXISTS (SELECT 1 FROM "public"."item_grants" g
                          WHERE g."node_id" = d."id" AND g."workspace_id" = add_ws
                            AND NOT g."excluded")
         AND (d."id" = x."id" OR (
               NOT EXISTS (SELECT 1 FROM "public"."item_grants" g
                            WHERE g."node_id" = d."id" AND g."workspace_id" = add_ws)
               AND "public"."mantle_grant_kind_ok"(d."type", add_ws, true)
               AND NOT EXISTS (
                 SELECT 1 FROM "public"."nodes" a
                   JOIN "public"."item_grants" ag ON ag."node_id" = a."id"
                                                 AND ag."workspace_id" = add_ws AND ag."excluded"
                  WHERE a."owner_id" = x."owner_id" AND a."type" = 'branch'
                    AND a."path" <@ x."path" AND a."id" <> x."id" AND a."id" <> d."id"
                    AND d."path" <@ a."path")))) END,
    CASE WHEN add_ws IS NULL THEN 0 ELSE (
      SELECT count(*)::int FROM sub d
       WHERE d."type" = 'app'
         AND NOT EXISTS (SELECT 1 FROM "public"."item_grants" g
                          WHERE g."node_id" = d."id" AND g."workspace_id" = add_ws
                            AND NOT g."excluded")
         AND (d."id" = x."id" OR (
               NOT EXISTS (SELECT 1 FROM "public"."item_grants" g
                            WHERE g."node_id" = d."id" AND g."workspace_id" = add_ws)
               AND "public"."mantle_grant_kind_ok"(d."type", add_ws, true)
               AND NOT EXISTS (
                 SELECT 1 FROM "public"."nodes" a
                   JOIN "public"."item_grants" ag ON ag."node_id" = a."id"
                                                 AND ag."workspace_id" = add_ws AND ag."excluded"
                  WHERE a."owner_id" = x."owner_id" AND a."type" = 'branch'
                    AND a."path" <@ x."path" AND a."id" <> x."id" AND a."id" <> d."id"
                    AND d."path" <@ a."path")))) END,
    CASE WHEN remove_ws IS NULL THEN 0 ELSE (
      SELECT count(*)::int FROM sub d
       WHERE EXISTS (SELECT 1 FROM "public"."item_grants" g
                      WHERE g."node_id" = d."id" AND g."workspace_id" = remove_ws
                        AND NOT g."excluded"
                        AND ((d."id" = x."id" AND NOT g."is_home")
                             OR (d."id" <> x."id" AND g."via_folder_id" IS NOT NULL)))
         AND (d."id" = x."id" OR NOT EXISTS (
               SELECT 1 FROM "public"."nodes" a
                 JOIN "public"."item_grants" ag ON ag."node_id" = a."id"
                                               AND ag."workspace_id" = remove_ws
                                               AND NOT ag."excluded" AND ag."via_folder_id" IS NULL
                WHERE a."owner_id" = x."owner_id" AND a."type" = 'branch'
                  AND a."path" <@ x."path" AND a."id" <> x."id" AND a."id" <> d."id"
                  AND d."path" <@ a."path"))) END,
    CASE WHEN x."type" = 'branch' AND x."path" IS NOT NULL
         THEN (SELECT count(*)::int FROM "public"."nodes" h
                WHERE h."owner_id" = x."owner_id" AND h."path" <@ x."path"
                  AND NOT coalesce(h."read_ws" && x.ws, false))
         ELSE 0 END,
    CASE WHEN x."type" = 'app'
         THEN (SELECT count(*)::int FROM "public"."app_table_exports" e
                WHERE e."app_node_id" = x."id")
         ELSE 0 END
    FROM x
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_grant_counts"(uuid, uuid, uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_grant_counts"(uuid, uuid, uuid, uuid[]) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_item_embeds"(node uuid)
  RETURNS TABLE ("to_id" uuid, "type" "public"."node_type", "hop" boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH i AS (
    SELECT n."id" FROM "public"."nodes" n
     WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"()
       AND (NOT "public"."mantle_scope_active"()
            OR (n."read_ws" && "public"."mantle_scope_ws"()
                AND (n."login_id" IS NULL OR n."login_id" = "public"."mantle_login_id"())))
  ),
  direct AS (
    SELECT e."to_id", t."type" FROM i
      JOIN "public"."node_embeds" e ON e."from_id" = i."id"
      JOIN "public"."nodes" t ON t."id" = e."to_id"
  )
  SELECT d."to_id", d."type", false FROM direct d
  UNION ALL
  SELECT h."to_id", t."type", true FROM direct d
    JOIN "public"."node_embeds" h ON h."from_id" = d."to_id"
    LEFT JOIN "public"."nodes" t ON t."id" = h."to_id"
   WHERE d."type" = 'draw'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_item_embeds"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_item_embeds"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_seen"(login uuid)
  RETURNS TABLE ("id" uuid, "name" text, "description" text, "contact_id" uuid,
                 "is_admin" boolean, "landing_app_id" uuid, "archived_at" timestamptz,
                 "color" text, "icon" text, "user_count" integer,
                 "resource_count" integer, "me_member" boolean, "me_moderator" boolean,
                 "agent_id" uuid, "agent_name" text, "agent_history" boolean,
                 "landing_held" boolean, "landing_ready" boolean, "landing_title" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT w."id", w."name", w."description", w."contact_id", w."is_admin", w."landing_app_id",
         w."archived_at", w."color", w."icon",
         (SELECT count(*)::int FROM "public"."workspace_users" u WHERE u."workspace_id" = w."id"),
         (SELECT count(*)::int FROM "public"."workspace_resources" r WHERE r."workspace_id" = w."id"),
         me."login_id" IS NOT NULL, coalesce(me."moderator", false),
         a."id", a."name",
         CASE WHEN a."id" IS NULL THEN false ELSE "public"."mantle_agent_has_history"(a."id") END,
         app."node_id" IS NOT NULL,
         coalesce((app."published_build" ->> 'ok')::boolean, false),
         CASE WHEN me."login_id" IS NOT NULL THEN app."title" END
    FROM "public"."workspaces" w
    LEFT JOIN "public"."workspace_users" me ON me."workspace_id" = w."id" AND me."login_id" = login
    LEFT JOIN "public"."workspace_resources" ar ON ar."workspace_id" = w."id" AND ar."type" = 'assistant'
    LEFT JOIN "public"."agents" a ON a."id"::text = ar."ref_id"
    LEFT JOIN LATERAL (
      SELECT p."node_id", p."published_build", n."title"
        FROM "public"."nodes" n JOIN "public"."apps" p ON p."node_id" = n."id"
       WHERE n."id" = w."landing_app_id" AND n."owner_id" = w."owner_id" AND n."type" = 'app'
         AND w."id" = ANY (n."read_ws")
       LIMIT 1) app ON true
   WHERE w."owner_id" = "public"."mantle_brain_id"()
     AND (NOT "public"."mantle_scope_active"()
          OR (login = "public"."mantle_login_id"()
              AND ("public"."mantle_scope_has_area"('users')
                   OR (me."login_id" IS NOT NULL AND w."archived_at" IS NULL))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_seen"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_seen"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_people"(ws uuid)
  RETURNS TABLE ("login_id" uuid, "name" text, "email" text, "moderator" boolean,
                 "added_by" uuid, "added_by_name" text, "added_at" timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT u."login_id", x."display_name", x."email", u."moderator", u."added_by",
         coalesce(nullif(btrim(b."display_name"), ''), b."email"), u."added_at"
    FROM "public"."workspace_users" u
    JOIN "public"."workspaces" w ON w."id" = u."workspace_id"
    JOIN auth.users x ON x."id" = u."login_id"
    LEFT JOIN auth.users b ON b."id" = u."added_by"
   WHERE u."workspace_id" = ws AND w."owner_id" = "public"."mantle_brain_id"()
     AND (NOT "public"."mantle_scope_active"()
          OR ws = ANY ("public"."mantle_scope_ws"())
          OR "public"."mantle_scope_has_area"('users'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_people"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_people"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_resource_rows"(ws uuid)
  RETURNS TABLE ("type" text, "ref_id" text, "write" boolean, "name" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT r."type", r."ref_id", r."write", coalesce(a."name", g."name", r."ref_id")
    FROM "public"."workspace_resources" r
    JOIN "public"."workspaces" w ON w."id" = r."workspace_id"
    LEFT JOIN "public"."agents" a ON r."type" = 'assistant' AND a."id"::text = r."ref_id"
    LEFT JOIN "public"."tool_groups" g ON r."type" = 'connector' AND g."slug" = r."ref_id"
                                     AND g."owner_id" = w."owner_id"
   WHERE r."workspace_id" = ws AND w."owner_id" = "public"."mantle_brain_id"()
     AND (NOT "public"."mantle_scope_active"()
          OR ws = ANY ("public"."mantle_scope_ws"())
          OR "public"."mantle_scope_has_area"('users'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_resource_rows"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_resource_rows"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_item_counts"(ws uuid)
  RETURNS TABLE ("items" integer, "grants" integer, "exclusions" integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT count(*) FILTER (WHERE g."is_home")::int,
         count(*) FILTER (WHERE NOT g."is_home" AND NOT g."excluded")::int,
         count(*) FILTER (WHERE g."excluded")::int
    FROM "public"."item_grants" g
   WHERE g."workspace_id" = ws
     AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."id" = ws AND w."owner_id" = "public"."mantle_brain_id"())
     AND (NOT "public"."mantle_scope_active"()
          OR ws = ANY ("public"."mantle_scope_mod_ws"())
          OR "public"."mantle_scope_has_area"('users'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_item_counts"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_item_counts"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_login_search"(term text, lim integer, off integer)
  RETURNS TABLE ("id" uuid, "name" text, "email" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT u."id", u."display_name", u."email"
    FROM auth.users u
   WHERE u."disabled_at" IS NULL
     AND (NOT "public"."mantle_scope_active"()
          OR "public"."mantle_scope_has_area"('users')
          OR (cardinality("public"."mantle_scope_mod_ws"()) > 0
              AND length(btrim(coalesce(term, ''))) >= 3 AND lim <= 10 AND off = 0))
     AND (coalesce(term, '') = ''
          OR u."email" ILIKE '%' || regexp_replace(term, '([\\%_])', '\\\1', 'g') || '%'
          OR coalesce(u."display_name", '')
               ILIKE '%' || regexp_replace(term, '([\\%_])', '\\\1', 'g') || '%')
   ORDER BY lower(coalesce(u."display_name", u."email")), u."id"
   LIMIT greatest(lim, 0) OFFSET greatest(off, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_login_search"(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_login_search"(text, integer, integer) TO "mantle_view_user";
--> statement-breakpoint
-- The public demo's SELECT-only reader serves owner reads (as 0285, 0286).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_item_grants"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_grant_counts"(uuid, uuid, uuid, uuid[]) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_item_embeds"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_seen"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_people"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_resource_rows"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_item_counts"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_login_search"(text, integer, integer) TO demo_reader;
    -- 0279's, now read where these read (the workspace screens, the move
    -- preview's names).
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_admin_id"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_names"(uuid[], uuid) TO demo_reader;
  END IF;
END
$$;
