-- Rollback of 0307_ws_user_definers: what an operator runs BEFORE pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not
-- a migration: nothing runs it on its own.
--
-- Why: 0307 tightened four functions the image before it calls the old way.
-- With 0307 in place that image:
--   - makes no private workspace (createHomeFallback calls
--     mantle_ws_private_workspace on the system pool with no scope login):
--     a member's first create, and every create that needs the private
--     workspace, is refused ("You have no workspace to create in yet.");
--   - attaches no default assistant at signup or onboarding (its
--     mantle_ws_attach_assistants call there is no system work for 0307);
--   - has any unscoped mantle_ws_create or mantle_workspace_event call
--     refused (none in that image's product code; a hand call too).
-- This file puts those four back exactly as 0293, 0272, 0279 and 0260 left
-- them (the bodies are copied verbatim; the 0307 cell "the revert puts the
-- four back byte for byte" checks them against a database just before
-- 0307), and
-- takes 0307 off the ledger so a later roll forward applies it again. The
-- functions 0307 added stay: the older image never calls them, and they
-- refuse more, never less. CREATE OR REPLACE keeps every grant.
--
-- Run it as the superuser that runs the migrations, in one transaction:
--   docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 \
--     < packages/db/rollback/0307_ws_user_definers.revert.sql
-- then pin the older image (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- 0293's mantle_ws_create.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_create"(
  owner uuid, login uuid, ws_name text, ws_description text)
  RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  wid uuid;
BEGIN
  IF "public"."mantle_scope_active"() AND NOT (
       login IS NOT DISTINCT FROM "public"."mantle_scope_login_id"()
       AND owner = "public"."mantle_brain_id"()) THEN
    RAISE EXCEPTION 'mantle_ws_create: only the scope''s own login, on its brain'
      USING ERRCODE = '42501';
  END IF;
  IF "public"."mantle_ws_admin_id"(owner) IS NULL THEN
    RAISE EXCEPTION 'mantle_ws_create: workspaces are not set up on this brain'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO "public"."workspaces" ("owner_id", "name", "description", "created_by")
  VALUES (owner, ws_name, coalesce(ws_description, ''), login)
  RETURNING "id" INTO wid;
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator", "added_by")
  VALUES (wid, login, true, login);
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (wid, login, 'workspace.create', jsonb_build_object('name', ws_name));
  RETURN wid;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_create"(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
-- 0272's mantle_ws_private_workspace.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_private_workspace"(login uuid)
  RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  ws uuid;
  label text;
BEGIN
  IF login IS NULL OR brain IS NULL OR "public"."mantle_ws_skip_reason"() IS NOT NULL
     OR EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = login)
     OR NOT EXISTS (SELECT 1 FROM "public"."workspaces" w WHERE w."owner_id" = brain AND w."is_admin") THEN
    RETURN NULL;
  END IF;
  SELECT left(coalesce(nullif(btrim(u."display_name"), ''), split_part(u."email", '@', 1)), 100)
    INTO label FROM auth.users u WHERE u."id" = login AND u."disabled_at" IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- One at a time per login: two first creates make one workspace.
  PERFORM pg_advisory_xact_lock(hashtext('mantle_ws_private_workspace'), hashtext(login::text));
  SELECT p."workspace_id" INTO ws
    FROM "public"."private_workspaces" p
    JOIN "public"."workspaces" w ON w."id" = p."workspace_id" AND w."archived_at" IS NULL
   WHERE p."login_id" = login;
  IF ws IS NOT NULL THEN RETURN ws; END IF;
  INSERT INTO "public"."workspaces" ("owner_id", "name", "description", "created_by")
  VALUES (brain, btrim(label || ' (only you)'), 'Your own work. Only you see it.', login)
  RETURNING "id" INTO ws;
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
  VALUES (ws, login, true);
  INSERT INTO "public"."private_workspaces" ("login_id", "workspace_id") VALUES (login, ws)
  ON CONFLICT ("login_id") DO UPDATE SET "workspace_id" = EXCLUDED."workspace_id";
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  -- The same event 0264 writes: a login removed later is found by it
  -- (its workspace becomes its Former user workspace, mantle_ws_review_off).
  VALUES (ws, NULL, 'review_off.private', jsonb_build_object('login', login));
  RETURN ws;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_private_workspace"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- 0279's mantle_workspace_event.
CREATE OR REPLACE FUNCTION "public"."mantle_workspace_event"(
  ws uuid, actor uuid, action text, subject jsonb)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  node uuid;
BEGIN
  IF action IS NULL OR action NOT LIKE 'grant.%' THEN
    RAISE EXCEPTION 'mantle_workspace_event: only grant.* actions' USING ERRCODE = '22023';
  END IF;
  -- Held to the scope (L5; fix round 2, L3): a workspace of the scope, or
  -- one that holds a grant row on the subject's item (`node`) whose home
  -- the scope manages (a home's manager may exclude a grant of a workspace
  -- it is not in; a removal is logged before its row goes, grants.ts). An
  -- event in any other workspace is refused: never a forged one.
  IF "public"."mantle_scope_active"() AND NOT coalesce(ws = ANY ("public"."mantle_scope_ws"()), false) THEN
    node := CASE WHEN jsonb_typeof(subject) = 'object' AND subject ->> 'node' ~ '^[0-9a-fA-F-]{36}$'
                 THEN (subject ->> 'node')::uuid END;
    PERFORM "public"."mantle_grant_refuses"(
      node IS NOT NULL
      AND EXISTS (SELECT 1 FROM "public"."item_grants" g
                   WHERE g."node_id" = node AND g."workspace_id" = ws)
      AND coalesce((
        SELECT "public"."mantle_may_manage_home"(n."home_ws") FROM "public"."nodes" n
         WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"()), false),
      'workspace_events: a workspace outside the scope',
      'not allowed to grant to that workspace');
  END IF;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, coalesce("public"."mantle_login_id"(), actor), action, subject);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_workspace_event"(uuid, uuid, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
-- 0260's mantle_ws_attach_assistants (an invoker again).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_attach_assistants"()
  RETURNS integer LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp
  SET lock_timeout = '10s' AS $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  admin_ws uuid;
  team_ws uuid;
  pick uuid;
  added integer := 0;
BEGIN
  IF brain IS NULL THEN RETURN 0; END IF;
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = brain AND w."bridge_key" = 'admin';
  SELECT w."id" INTO team_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = brain AND w."bridge_key" = 'team';
  IF admin_ws IS NULL THEN RETURN 0; END IF;
  -- The persona on Admin: the selection of 0251 (the enabled admin-level
  -- responder, highest priority, a shared one before a login's own).
  IF NOT EXISTS (SELECT 1 FROM "public"."workspace_resources" r
                  WHERE r."workspace_id" = admin_ws AND r."type" = 'assistant')
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_events" e
                      WHERE e."workspace_id" = admin_ws AND e."action" = 'resource.remove'
                        AND e."subject" ->> 'kind' = 'assistant') THEN
    SELECT a."id" INTO pick FROM "public"."agents" a
     WHERE a."owner_id" = brain AND a."role" = 'responder' AND a."audience" = 'admin' AND a."enabled"
       AND a."workspace_id" IS NULL
     ORDER BY a."priority" DESC, a."assigned_user_id" IS NOT NULL, a."created_at"
     LIMIT 1;
    IF pick IS NOT NULL THEN
      INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
      VALUES (admin_ws, 'assistant', pick::text, true);
      INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
      VALUES (admin_ws, NULL, 'resource.add',
              jsonb_build_object('kind', 'assistant', 'id', pick, 'by', 'attach'));
      added := added + 1;
    END IF;
  END IF;
  -- The team responder on Team.
  IF team_ws IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_resources" r
                      WHERE r."workspace_id" = team_ws AND r."type" = 'assistant')
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_events" e
                      WHERE e."workspace_id" = team_ws AND e."action" = 'resource.remove'
                        AND e."subject" ->> 'kind' = 'assistant') THEN
    pick := NULL;
    SELECT a."id" INTO pick FROM "public"."agents" a
     WHERE a."owner_id" = brain AND a."slug" = 'team-responder' AND a."audience" = 'team'
       AND a."enabled" AND a."workspace_id" IS NULL
     LIMIT 1;
    IF pick IS NOT NULL THEN
      INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
      VALUES (team_ws, 'assistant', pick::text, true);
      INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
      VALUES (team_ws, NULL, 'resource.add',
              jsonb_build_object('kind', 'assistant', 'id', pick, 'by', 'attach'));
      added := added + 1;
    END IF;
  END IF;
  RETURN added;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_attach_assistants"() FROM PUBLIC;
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0307 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790197740000;
