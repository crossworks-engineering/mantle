-- Arch A6b (plan v2 page fcc4aee4, the system-pool exits toward 40): where
-- a library left the caller's scope for the system pool to read one answer
-- the scope does not hold, a definer here returns exactly that answer, and
-- the library asks it in the scope.
--
-- Every definer below: a fixed search_path (pg_temp last), no right for
-- PUBLIC, EXECUTE for the workspace role (and so the write role, which
-- mirrors its function rights: applyViewerGrants, and the runtime role,
-- whose allowlist holds what a viewer role may run) and the public demo's
-- SELECT-only reader when it exists. The caller is read from the scope's
-- settings, never from an argument; with no scope set (the system pool) a
-- definer answers as the system pool read.
--
-- 1. mantle_kind_root_id(owner, label): the id of a kind's root folder (the
--    top-level branch at `label`: the files root), whatever the scope
--    holds. Structure, not content: the root is homed in Admin, and a
--    reader that does not see it must not make it again (W6b). Only the id:
--    the system pool read the whole row ('kind-root'), and every caller
--    asked only whether it is there. In a scope only the brain's own.
-- 2. mantle_agent_experience(owner, agent_ids): an assistant's level (its
--    completed replies and tool successes, its delegations and heartbeat
--    fires), counted over every login's turns. The one counting rule:
--    lib/agent-experience.ts asks it everywhere (the agents screen on the
--    system pool, the chat bundle's badge in an Admin user's scope). In a
--    scope only a scope that holds Admin, and only for the assistants it
--    reads (the badge of the assistant the login chats with).
-- 3. mantle_read_cursors(owner, login) and mantle_read_cursor_mark(owner,
--    agent, login, at): the login's own chat read cursors (the inbox's
--    unread counts), read and set. In a scope only the scope's own login,
--    and marked only for an assistant the scope reads.
-- 4. mantle_access_keys_seen(login, ended_limit) and
--    mantle_access_key_revoke(key, login): the API access screen. A login's
--    own keys (every live one and the newest ended ones), with its email,
--    name and role and its maker's email; every key for an Admin user (a
--    login whose role is admin, live: login = NULL). Never the key's hash.
--    A revoke: the login's own live key, any live key for an Admin user. In
--    a scope only the scope's own login.
-- 5. mantle_pending_count(owner): the brain's pending approvals (the shell's
--    badge and a push's count), every login's; in a scope only for one that
--    holds Admin.
-- 6. mantle_ws_private_for(ws, login): whether `ws` is `login`'s own private
--    workspace (the shell's switcher marks it); in a scope only the scope's
--    own login.
-- 7. The connector reads (packages/tools external-access.ts): a
--    connector's state (mantle_connector_state: its id and whether it is
--    usable, never its binding or OAuth config), which live workspaces of
--    `ws` hold it with their Write tick (mantle_connector_rows), whether a
--    live workspace beyond Admin holds it (mantle_connector_beyond_admin),
--    the workspaces holding an app (mantle_app_holders: an app the scope
--    reads), and one login's live workspaces with the connectors each holds
--    (mantle_login_connector_rows: in a scope, the scope's own login only).
-- 8. mantle_contact_sharing(owner, ids): the code dates of the contacts
--    with sharing on (contact_share_codes, never the code): the caller read
--    the contacts, the id list is the rule (as on the system pool); in a
--    scope only the brain's.
-- 9. mantle_file_name_taken(owner, parent, name): a file in `parent` with
--    that name (ignoring case): its id, whether it is a folded member file,
--    whether the name is exact. Structure, never content; in a scope only
--    the brain's.
-- 10. mantle_table_app_link(table): the app a Table is the export of, yes
--    or no and its id (the guard of a grid write and a delete; in a scope,
--    the brain's).
-- 11. mantle_access_log_names(app, ids): the names of logins that are
--    actors on the access log of an app (in a scope, an app the scope
--    reads): the display name, else the email's local part.
-- 12. mantle_runs_workspaces(run_ids, item_ids): the workspace each named
--    run is stamped with (a run item's run), so a scope that queues jobs can
--    be checked to carry them. Workspace ids only.
-- 13. mantle_lexeme_df(text, tbl, count_lexemes, count_cap): the document
--    frequency of the caller's own query terms in `nodes` or
--    `content_chunks` (pg_stats, hidden from a role under row security,
--    else a capped count): numbers for the caller's terms, never a row.
-- 14. mantle_deleted_apps(owner): each deleted app's newest pre_delete
--    snapshot (no code: its meta, its data file, whether it is held), with
--    its home. In a scope only the apps the scope may manage: a home among
--    the scope's Moderator workspaces (the anchor login: its Moderator
--    seats in every live workspace), or no home and the anchor login.
-- 15. The Telegram screens (server/web lib/agent-telegram.ts; the
--    Telegram tables are granted to no role): a login's own paired chats
--    (mantle_tg_my_chats), and the chats of every bot the login moderates
--    (mantle_tg_moderated_chats: a Moderator of the bot's assistant's
--    workspace, an Admin user with the users area; a brain not on
--    workspaces, the anchor login), with the paired login's name and email.
--    mantle_tg_replay: a login's own Telegram history in a window (each
--    message's node carries its chat's login; one from before logins is the
--    anchor's). In a scope, the scope's own login only.
--    mantle_login_area(login, area) is their internal rule (packages/db
--    loginHasArea, in SQL): no role may run it.
--
-- The writes (3, 4) are the write role's (WRITE_ROLE_FUNCTIONS,
-- access-matrix.ts: applyViewerGrants grants them), not the workspace
-- role's: a scope reaches them only from a write.
--
-- No table, no row, no trigger and no LLM work changes. Re-runnable:
-- CREATE OR REPLACE only.

CREATE OR REPLACE FUNCTION "public"."mantle_kind_root_id"(owner uuid, label text)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT n."id" FROM "public"."nodes" n
   WHERE n."owner_id" = owner AND n."type" = 'branch' AND n."path"::text = label
     AND nlevel(n."path") = 1
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_kind_root_id"(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_kind_root_id"(uuid, text) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_agent_experience"(owner uuid, agent_ids uuid[])
  RETURNS TABLE ("agent_id" uuid, "turns" integer, "tool_successes" integer,
                 "delegations" integer, "heartbeats" integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH ok AS (
    SELECT NOT "public"."mantle_scope_active"()
           OR (owner = "public"."mantle_brain_id"() AND "public"."mantle_scope_is_admin"()) AS yes
  ), seen AS (
    -- In a scope, the assistants the scope reads (agents' row rule, 0254).
    SELECT g."id" FROM "public"."agents" g
     WHERE "public"."mantle_scope_active"()
       AND (g."workspace_id" IS NULL OR g."workspace_id" = ANY ("public"."mantle_scope_ws"()))
  ), t AS (
    SELECT m."agent_id", count(*)::int AS turns,
           coalesce(sum(CASE WHEN jsonb_typeof(m."data" -> 'toolStats' -> 'succeeded') = 'number'
                             THEN (m."data" -> 'toolStats' ->> 'succeeded')::int ELSE 0 END), 0)::int
             AS tool_successes
      FROM "public"."assistant_messages" m
     WHERE m."owner_id" = owner AND m."direction" = 'outbound' AND m."status" = 'complete'
       AND m."agent_id" IS NOT NULL AND NOT (m."data" ? 'superseded_by')
       AND (agent_ids IS NULL OR m."agent_id" = ANY (agent_ids))
     GROUP BY m."agent_id"
  ), r AS (
    SELECT tr."agent_id",
           count(*) FILTER (WHERE tr."kind" = 'manual' AND tr."subject_kind" = 'child_agent')::int
             AS delegations,
           count(*) FILTER (WHERE tr."kind" = 'heartbeat_fire')::int AS heartbeats
      FROM "public"."traces" tr
     WHERE tr."owner_id" = owner AND tr."status" = 'success' AND tr."agent_id" IS NOT NULL
       AND (tr."kind" = 'heartbeat_fire' OR (tr."kind" = 'manual' AND tr."subject_kind" = 'child_agent'))
       AND (agent_ids IS NULL OR tr."agent_id" = ANY (agent_ids))
     GROUP BY tr."agent_id"
  )
  SELECT coalesce(t."agent_id", r."agent_id"), coalesce(t.turns, 0), coalesce(t.tool_successes, 0),
         coalesce(r.delegations, 0), coalesce(r.heartbeats, 0)
    FROM t FULL JOIN r ON r."agent_id" = t."agent_id"
   WHERE (SELECT yes FROM ok)
     AND (NOT "public"."mantle_scope_active"()
          OR coalesce(t."agent_id", r."agent_id") IN (SELECT "id" FROM seen))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_agent_experience"(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_agent_experience"(uuid, uuid[]) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_read_cursors"(owner uuid, login uuid)
  RETURNS TABLE ("agent_id" uuid, "last_read_at" timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT c."agent_id", c."last_read_at" FROM "public"."assistant_read_cursors" c
   WHERE c."owner_id" = owner AND c."login_id" = login
     AND (NOT "public"."mantle_scope_active"()
          OR (login = "public"."mantle_scope_login_id"() AND owner = "public"."mantle_brain_id"()))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_read_cursors"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_read_cursors"(uuid, uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_read_cursor_mark"(
  owner uuid, agent uuid, login uuid, at timestamptz)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF "public"."mantle_scope_active"() AND NOT (
       login IS NOT DISTINCT FROM "public"."mantle_scope_login_id"()
       AND owner = "public"."mantle_brain_id"()
       AND EXISTS (SELECT 1 FROM "public"."agents" g
                    WHERE g."id" = agent
                      AND (g."workspace_id" IS NULL
                           OR g."workspace_id" = ANY ("public"."mantle_scope_ws"())))) THEN
    RAISE EXCEPTION 'mantle_read_cursor_mark: only the scope''s own login, for an assistant it reads'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO "public"."assistant_read_cursors" ("owner_id", "agent_id", "login_id", "last_read_at")
  VALUES (owner, agent, login, at)
  ON CONFLICT ("owner_id", "agent_id", "login_id") DO UPDATE SET "last_read_at" = excluded."last_read_at";
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_read_cursor_mark"(uuid, uuid, uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint

-- Whether `login` is an Admin user now (role admin, not disabled): what the
-- session guard answers as `kind: 'admin'` (login-row.ts).
CREATE OR REPLACE FUNCTION "public"."mantle_login_is_admin_user"(login uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "auth"."users" l
                  WHERE l."id" = login AND l."role" = 'admin' AND l."disabled_at" IS NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_login_is_admin_user"(uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_access_keys_seen"(login uuid, ended_limit integer)
  RETURNS TABLE ("id" uuid, "name" text, "key_prefix" text, "login_id" uuid, "access" text,
                 "areas" text[], "risky_tools" text[], "expires_at" timestamptz,
                 "created_by" uuid, "created_at" timestamptz, "last_used_at" timestamptz,
                 "last_used_ip" text, "revoked_at" timestamptz, "live" boolean,
                 "login_email" text, "login_name" text, "login_role" text, "maker_email" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH caller AS (
    -- login NULL: every key, an Admin user's view (in a scope, the scope's
    -- login must be one); else that login's own keys (in a scope, its own).
    SELECT CASE
             WHEN NOT "public"."mantle_scope_active"() THEN true
             WHEN login IS NULL THEN "public"."mantle_login_is_admin_user"("public"."mantle_scope_login_id"())
             ELSE login = "public"."mantle_scope_login_id"()
           END AS ok
  ), k AS (
    SELECT a.*, (a."revoked_at" IS NULL AND (a."expires_at" IS NULL OR a."expires_at" > now())) AS live
      FROM "public"."access_keys" a
     WHERE (SELECT ok FROM caller) AND (login IS NULL OR a."login_id" = login)
  ), shown AS (
    SELECT * FROM k WHERE k.live
    UNION ALL
    (SELECT * FROM k WHERE NOT k.live ORDER BY k."created_at" DESC LIMIT ended_limit)
  )
  SELECT s."id", s."name", s."key_prefix", s."login_id", s."access", s."areas", s."risky_tools",
         s."expires_at", s."created_by", s."created_at", s."last_used_at", s."last_used_ip",
         s."revoked_at", s.live, l."email", l."display_name", l."role"::text, m."email"
    FROM shown s
    LEFT JOIN "auth"."users" l ON l."id" = s."login_id"
    LEFT JOIN "auth"."users" m ON m."id" = s."created_by"
   ORDER BY s.live DESC, s."created_at" DESC
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_access_keys_seen"(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_access_keys_seen"(uuid, integer) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_access_key_revoke"(key uuid, login uuid)
  RETURNS TABLE ("id" uuid, "key_prefix" text, "name" text, "login_id" uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  who uuid := login;
BEGIN
  IF "public"."mantle_scope_active"() THEN
    IF login IS DISTINCT FROM "public"."mantle_scope_login_id"() THEN
      RAISE EXCEPTION 'mantle_access_key_revoke: only the scope''s own login' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN QUERY
  UPDATE "public"."access_keys" a SET "revoked_at" = now(), "revoked_by" = who
   WHERE a."id" = key AND a."revoked_at" IS NULL
     AND (a."login_id" = who OR "public"."mantle_login_is_admin_user"(who))
  RETURNING a."id", a."key_prefix", a."name", a."login_id";
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_access_key_revoke"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_pending_count"(owner uuid)
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT count(*)::int FROM "public"."pending_tool_calls" p
   WHERE p."owner_id" = owner AND p."status" = 'pending'
     AND (NOT "public"."mantle_scope_active"()
          OR (owner = "public"."mantle_brain_id"() AND "public"."mantle_scope_is_admin"()))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_pending_count"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_pending_count"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_private_for"(ws uuid, login uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                  WHERE p."workspace_id" = ws AND p."login_id" = login)
     AND (NOT "public"."mantle_scope_active"() OR login = "public"."mantle_scope_login_id"())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_private_for"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_private_for"(uuid, uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_connector_state"(owner uuid, slug text)
  RETURNS TABLE ("id" uuid, "slug" text, "usable" boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT g."id", g."slug", (g."enabled" AND coalesce(g."integration" ? 'mcp', false))
    FROM "public"."tool_groups" g
   WHERE g."owner_id" = owner AND g."slug" = mantle_connector_state.slug
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_connector_state"(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_connector_state"(uuid, text) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_connector_rows"(owner uuid, slug text, ws uuid[])
  RETURNS TABLE ("workspace_id" uuid, "write" boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT r."workspace_id", r."write"
    FROM "public"."workspace_resources" r
    JOIN "public"."workspaces" w ON w."id" = r."workspace_id"
   WHERE r."type" = 'connector' AND r."ref_id" = slug AND w."owner_id" = owner
     AND w."archived_at" IS NULL AND r."workspace_id" = ANY (ws)
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_connector_rows"(uuid, text, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_connector_rows"(uuid, text, uuid[]) TO "mantle_view_user";
--> statement-breakpoint

-- NULL when no live workspace beyond Admin holds the connector, else
-- whether one of them has its Write on.
CREATE OR REPLACE FUNCTION "public"."mantle_connector_beyond_admin"(owner uuid, slug text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT bool_or(r."write")
    FROM "public"."workspace_resources" r
    JOIN "public"."workspaces" w ON w."id" = r."workspace_id"
   WHERE r."type" = 'connector' AND r."ref_id" = slug AND w."owner_id" = owner
     AND NOT w."is_admin" AND w."archived_at" IS NULL
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_connector_beyond_admin"(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_connector_beyond_admin"(uuid, text) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_app_holders"(owner uuid, app uuid)
  RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT n."read_ws" FROM "public"."nodes" n
   WHERE n."owner_id" = owner AND n."id" = app AND n."type" = 'app'
     AND (NOT "public"."mantle_scope_active"()
          OR (owner = "public"."mantle_brain_id"()
              AND n."read_ws" && "public"."mantle_scope_ws"()
              AND (n."login_id" IS NULL OR n."login_id" = "public"."mantle_scope_login_id"())))
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_app_holders"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_app_holders"(uuid, uuid) TO "mantle_view_user";
--> statement-breakpoint

-- One row per live workspace of the login (slug and write NULL when it
-- holds no connector), and one per connector it holds.
CREATE OR REPLACE FUNCTION "public"."mantle_login_connector_rows"(owner uuid, login uuid)
  RETURNS TABLE ("workspace_id" uuid, "moderator" boolean, "slug" text, "write" boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT u."workspace_id", u."moderator", r."ref_id", r."write"
    FROM "public"."workspace_users" u
    JOIN "public"."workspaces" w ON w."id" = u."workspace_id"
    LEFT JOIN "public"."workspace_resources" r
      ON r."workspace_id" = u."workspace_id" AND r."type" = 'connector'
   WHERE u."login_id" = login AND w."owner_id" = owner AND w."archived_at" IS NULL
     AND (NOT "public"."mantle_scope_active"()
          OR (login = "public"."mantle_scope_login_id"() AND owner = "public"."mantle_brain_id"()))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_login_connector_rows"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_login_connector_rows"(uuid, uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_contact_sharing"(owner uuid, ids uuid[])
  RETURNS TABLE ("contact_id" uuid, "created_at" timestamptz, "rotated_at" timestamptz,
                 "last_used_at" timestamptz, "locked_until" timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT c."contact_id", c."created_at", c."rotated_at", c."last_used_at", c."locked_until"
    FROM "public"."contact_share_codes" c
   WHERE c."owner_id" = owner AND c."contact_id" = ANY (ids) AND c."code_hash" IS NOT NULL
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_contact_sharing"(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_contact_sharing"(uuid, uuid[]) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_file_name_taken"(owner uuid, parent text, name text)
  RETURNS TABLE ("id" uuid, "folded" boolean, "exact" boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT n."id", coalesce(n."data" ? 'space_file', false),
         coalesce(n."data" ->> 'filename' = name, false) AS exact
    FROM "public"."nodes" n
   WHERE n."owner_id" = owner AND n."type" = 'file' AND n."path"::text = parent
     AND (lower(n."data" ->> 'filename') = lower(name) OR lower(n."slug") = lower(name))
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
   ORDER BY exact DESC, coalesce(n."data" ? 'space_file', false), n."id"
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_file_name_taken"(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_file_name_taken"(uuid, text, text) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_table_app_link"(tbl uuid)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT e."app_node_id" FROM "public"."app_table_exports" e
   WHERE e."table_node_id" = tbl
     AND (NOT "public"."mantle_scope_active"() OR e."owner_id" = "public"."mantle_brain_id"())
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_table_app_link"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_table_app_link"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_access_log_names"(app uuid, ids uuid[])
  RETURNS TABLE ("id" uuid, "name" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT l."id", coalesce(nullif(trim(l."display_name"), ''), split_part(l."email", '@', 1))
    FROM "auth"."users" l
   WHERE l."id" = ANY (ids)
     AND EXISTS (SELECT 1 FROM "public"."app_access_log" a
                  WHERE a."app_node_id" = app AND a."actor_id" = l."id")
     AND (NOT "public"."mantle_scope_active"()
          OR EXISTS (SELECT 1 FROM "public"."nodes" n
                      WHERE n."id" = app AND n."owner_id" = "public"."mantle_brain_id"()
                        AND n."read_ws" && "public"."mantle_scope_ws"()
                        AND (n."login_id" IS NULL
                             OR n."login_id" = "public"."mantle_scope_login_id"())))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_access_log_names"(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_access_log_names"(uuid, uuid[]) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_runs_workspaces"(run_ids uuid[], item_ids uuid[])
  RETURNS TABLE ("workspace_id" uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT r."workspace_id" FROM "public"."runs" r
   WHERE r."id" = ANY (run_ids)
      OR r."id" IN (SELECT i."run_id" FROM "public"."run_items" i WHERE i."id" = ANY (item_ids))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_runs_workspaces"(uuid[], uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_runs_workspaces"(uuid[], uuid[]) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_lexeme_df"(
  query text, tbl text, count_lexemes integer, count_cap integer, df_ceiling float8)
  RETURNS TABLE ("lexeme" text, "rows" float8, "df" float8)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF tbl NOT IN ('nodes', 'content_chunks') THEN
    RAISE EXCEPTION 'mantle_lexeme_df: nodes or content_chunks only' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY EXECUTE format($q$
    with lex as (
      select distinct unnest(tsvector_to_array(to_tsvector('english', $1))) as lexeme
    ),
    col as (
      select most_common_elems::text::text[] as elems, most_common_elem_freqs as freqs
      from pg_stats
      where schemaname = 'public' and tablename = %L and attname = 'search_tsv'
    ),
    stats as (
      select unnest(elems) as lexeme, unnest(freqs[1:array_length(elems, 1)]) as freq from col
    ),
    tracked as (
      select lex.lexeme, max(s.freq)::float8 as freq
      from lex left join stats s on s.lexeme = lex.lexeme
      group by lex.lexeme
    ),
    todo as (
      select t.lexeme,
             row_number() over (order by (t.lexeme ~ '[0-9]') desc, length(t.lexeme) desc, t.lexeme) as rn
      from tracked t where t.freq is null and strpos(t.lexeme, chr(92)) = 0
    ),
    total as (
      select greatest(reltuples, 1)::float8 as n from pg_class
      where oid = to_regclass('public.' || %L)
    ),
    counted as (
      select t.lexeme, t.freq,
        case when d.rn <= $2 then (
          select count(*)::float8 from (
            select 1 from public.%I c
            where c.search_tsv @@ (chr(39) || replace(t.lexeme, chr(39), chr(39) || chr(39)) || chr(39))::tsquery
            limit $3
          ) hits
        ) end as hits
      from tracked t left join todo d on d.lexeme = t.lexeme
    )
    select k.lexeme::text,
      (case
        when k.freq is not null then k.freq * coalesce((select n from total), 1)
        else k.hits
      end)::float8,
      (case
        when k.freq is not null then k.freq
        when k.hits is not null then k.hits / coalesce((select n from total), 1)
        else coalesce((select freqs[array_length(elems, 1) + 1] from col), $4)::float8
      end)::float8
    from counted k
  $q$, tbl, tbl, tbl) USING query, count_lexemes, count_cap, df_ceiling;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_lexeme_df"(text, text, integer, integer, float8) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_lexeme_df"(text, text, integer, integer, float8) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_deleted_apps"(owner uuid)
  RETURNS TABLE ("id" uuid, "home" text, "snapshot_id" uuid, "seq" integer, "created_at" timestamptz,
                 "meta" jsonb, "db_path" text, "db_bytes" bigint, "schema_version" integer,
                 "held" boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH last AS (
    SELECT DISTINCT ON (s."node_id") s.*
      FROM "public"."node_snapshots" s
     WHERE s."owner_id" = owner AND s."node_kind" = 'app' AND s."trigger" = 'pre_delete'
       AND NOT EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n."id" = s."node_id")
     ORDER BY s."node_id", s."seq" DESC
  ), homed AS (
    -- The home as the snapshot keeps it (item-acl.ts snapshotHomeSql).
    SELECT l.*, nullif(l."code" -> 'meta' ->> 'homeWs', '') AS home
      FROM last l
  ), me AS (
    SELECT "public"."mantle_scope_login_id"() AS login,
           "public"."mantle_scope_login_id"() = "public"."mantle_brain_id"() AS anchor
  ), mods AS (
    -- The anchor's every live Moderator seat; anyone else the scope's own.
    SELECT CASE WHEN (SELECT anchor FROM me)
                THEN coalesce((SELECT array_agg(u."workspace_id")
                                 FROM "public"."workspace_users" u
                                 JOIN "public"."workspaces" w ON w."id" = u."workspace_id"
                                WHERE u."login_id" = (SELECT login FROM me) AND u."moderator"
                                  AND w."archived_at" IS NULL), '{}'::uuid[])
                ELSE "public"."mantle_scope_mod_ws"() END AS ws
  )
  SELECT h."node_id", h.home, h."id", h."seq", h."created_at",
         jsonb_build_object('meta', h."code" -> 'meta'), h."db_path", h."db_bytes"::bigint,
         h."schema_version", coalesce((h."code" -> 'meta' ->> 'keepForOwner')::boolean, false)
    FROM homed h
   WHERE NOT "public"."mantle_scope_active"()
      OR (owner = "public"."mantle_brain_id"()
          AND CASE WHEN h.home IS NOT NULL THEN h.home = ANY ((SELECT ws FROM mods)::text[])
                   ELSE coalesce((SELECT anchor FROM me), false) END)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_deleted_apps"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_deleted_apps"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_login_area"(login uuid, area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                      WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin")
      OR EXISTS (SELECT 1 FROM "public"."workspaces" w
                   JOIN "public"."workspace_users" u ON u."workspace_id" = w."id" AND u."login_id" = login
                   JOIN "auth"."users" l ON l."id" = u."login_id" AND l."disabled_at" IS NULL
                  WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin"
                    AND w."archived_at" IS NULL
                    AND area IN ('settings', 'users', 'assistants', 'connectors', 'keys')
                    AND coalesce(u."limits" -> 'areas' ->> area, '') <> 'false')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_login_area"(uuid, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_tg_my_chats"(owner uuid, login uuid)
  RETURNS TABLE ("id" uuid, "telegram_chat_id" text, "title" text, "username" text,
                 "last_message_at" timestamptz, "bot_username" text, "agent_name" text,
                 "agent_slug" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT c."id", c."telegram_chat_id", c."title", c."username", c."last_message_at",
         t."bot_username", a."name", a."slug"
    FROM "public"."telegram_chats" c
    JOIN "public"."telegram_accounts" t ON t."id" = c."account_id"
    LEFT JOIN "public"."channels" ch ON ch."id" = t."channel_id"
    LEFT JOIN "public"."agents" a ON a."id" = ch."agent_id"
   WHERE c."user_id" = owner AND c."login_id" = login AND c."allowlist_status" = 'allowed'
     AND (NOT "public"."mantle_scope_active"()
          OR (login = "public"."mantle_scope_login_id"() AND owner = "public"."mantle_brain_id"()))
   ORDER BY c."last_message_at" DESC NULLS LAST
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_tg_my_chats"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_tg_my_chats"(uuid, uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_tg_moderated_chats"(owner uuid, login uuid)
  RETURNS TABLE ("account_id" uuid, "bot_username" text, "agent_name" text, "agent_slug" text,
                 "id" uuid, "telegram_chat_id" text, "title" text, "username" text,
                 "status" text, "last_message_at" timestamptz, "login_id" uuid,
                 "paired_name" text, "paired_email" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH admin_ws AS (
    SELECT w."id" FROM "public"."workspaces" w WHERE w."owner_id" = owner AND w."is_admin" LIMIT 1
  ), bots AS (
    SELECT t."id", t."bot_username", t."created_at", a."name" AS agent_name, a."slug" AS agent_slug
      FROM "public"."telegram_accounts" t
      LEFT JOIN "public"."channels" ch ON ch."id" = t."channel_id"
      LEFT JOIN "public"."agents" a ON a."id" = ch."agent_id"
     WHERE t."user_id" = owner
       AND (NOT "public"."mantle_scope_active"()
            OR (login = "public"."mantle_scope_login_id"() AND owner = "public"."mantle_brain_id"()))
       AND CASE
             WHEN NOT EXISTS (SELECT 1 FROM admin_ws) THEN login = owner
             ELSE EXISTS (
                    SELECT 1
                      FROM "public"."channels" ch2
                      JOIN "public"."agents" a2 ON a2."id" = ch2."agent_id" AND a2."owner_id" = owner
                      JOIN "public"."workspaces" w
                        ON w."id" = coalesce(a2."workspace_id", (SELECT "id" FROM admin_ws))
                       AND w."archived_at" IS NULL
                      JOIN "public"."workspace_users" u
                        ON u."workspace_id" = w."id" AND u."login_id" = login AND u."moderator"
                      JOIN "auth"."users" l ON l."id" = u."login_id" AND l."disabled_at" IS NULL
                     WHERE ch2."id" = t."channel_id")
                  OR "public"."mantle_login_area"(login, 'users')
           END
  )
  SELECT b."id", b."bot_username", b.agent_name, b.agent_slug,
         c."id", c."telegram_chat_id", c."title", c."username", c."allowlist_status"::text,
         c."last_message_at", c."login_id", l."display_name", l."email"
    FROM bots b
    JOIN "public"."telegram_chats" c ON c."account_id" = b."id" AND c."user_id" = owner
    LEFT JOIN "auth"."users" l ON l."id" = c."login_id"
   ORDER BY b."created_at", b."id"
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_tg_moderated_chats"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_tg_moderated_chats"(uuid, uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_tg_replay"(
  owner uuid, asker uuid, since timestamptz, until timestamptz, lim integer)
  RETURNS TABLE ("text" text, "sent_at" timestamptz, "direction" text, "from_name" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT m."text", m."sent_at", m."direction"::text, m."from_name"
    FROM "public"."telegram_messages" m
    JOIN "public"."telegram_chats" c ON c."id" = m."chat_id"
    JOIN "public"."nodes" n ON n."id" = m."node_id"
   WHERE c."user_id" = owner
     AND (n."login_id" = asker OR (n."login_id" IS NULL AND asker = owner))
     AND m."sent_at" >= since AND m."sent_at" <= until
     AND (NOT "public"."mantle_scope_active"()
          OR (asker = "public"."mantle_scope_login_id"() AND owner = "public"."mantle_brain_id"()))
   ORDER BY m."sent_at"
   LIMIT lim
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_tg_replay"(uuid, uuid, timestamptz, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_tg_replay"(uuid, uuid, timestamptz, timestamptz, integer) TO "mantle_view_user";
--> statement-breakpoint

-- The public demo's SELECT-only reader serves owner reads (as 0285, 0286, 0291).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_kind_root_id"(uuid, text) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_agent_experience"(uuid, uuid[]) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_read_cursors"(uuid, uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_access_keys_seen"(uuid, integer) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_pending_count"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_private_for"(uuid, uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_connector_state"(uuid, text) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_connector_rows"(uuid, text, uuid[]) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_connector_beyond_admin"(uuid, text) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_app_holders"(uuid, uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_login_connector_rows"(uuid, uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_contact_sharing"(uuid, uuid[]) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_file_name_taken"(uuid, text, text) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_table_app_link"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_access_log_names"(uuid, uuid[]) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_runs_workspaces"(uuid[], uuid[]) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_lexeme_df"(text, text, integer, integer, float8) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_deleted_apps"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_tg_my_chats"(uuid, uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_tg_moderated_chats"(uuid, uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_tg_replay"(uuid, uuid, timestamptz, timestamptz, integer) TO demo_reader;
  END IF;
END
$$;
