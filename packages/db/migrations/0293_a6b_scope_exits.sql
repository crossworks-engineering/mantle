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
  END IF;
END
$$;
