-- Rollback of 0399_s8b_role_follows_membership: what an operator runs
-- BEFORE pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It puts back the bodies the image before 0399 shipped: mantle_bridge_login
-- (0286, the Admin row in step with the role), mantle_login_is_admin_user
-- (0306, role admin AND membership), mantle_ws_add_user and
-- mantle_ws_remove_user (0307, no role write), mantle_ws_migrate_bridged
-- (0286, its users step through the bridge), mantle_login_is_admin and
-- mantle_area_rule (0304's own bodies, the same answers, off the seat), and
-- drops the role guard (users_role_guard and its function: that image
-- writes the role from the app's pools) and the four functions 0399 added
-- (that image never calls them). The column is exact when this
-- runs (the definers kept it so), so that image's role reads answer as
-- before. The bridges' triggers are not made again: 0261 had dropped them
-- on every brain that took the workspaces switch, and 0399's precondition
-- is that every brain has (brains without an Admin workspace: 0).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0399_s8b_role_follows_membership.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
-- The `when` below is the placeholder's; the CEO's renumber at the merge
-- changes it with the journal entry.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_role_guard" ON "auth"."users";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_login_role_guard"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_login"(login uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  admin_ws uuid;
  r text;
  changed int := 0;
  gone int;
BEGIN
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin';
  IF admin_ws IS NULL THEN RETURN; END IF;
  SELECT u."role" INTO r FROM auth.users u WHERE u."id" = login;
  IF EXISTS (SELECT 1 FROM "public"."archive_client_logins" a WHERE a."login_id" = login) THEN
    r := NULL;
  END IF;
  -- An admin login is a user of Admin, and a Moderator there.
  IF r = 'admin' THEN
    INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
    VALUES (admin_ws, login, true)
    ON CONFLICT ("workspace_id", "login_id") DO UPDATE SET "moderator" = true
     WHERE NOT "workspace_users"."moderator";
    GET DIAGNOSTICS changed = ROW_COUNT;
  END IF;
  -- Any other login is not.
  DELETE FROM "public"."workspace_users" u
   WHERE u."login_id" = login AND u."workspace_id" = admin_ws AND coalesce(r, '') <> 'admin';
  GET DIAGNOSTICS gone = ROW_COUNT;
  IF changed + gone > 0 THEN
    INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
    VALUES (admin_ws, NULL, 'bridge.login', jsonb_build_object('login', login, 'role', r));
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_is_admin_user"(login uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "auth"."users" l
                  WHERE l."id" = login AND l."role" = 'admin' AND l."disabled_at" IS NULL)
     AND "public"."mantle_login_is_admin"(login)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_add_user"(
  owner uuid, ws uuid, login uuid, moderator boolean)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  fn constant text := 'mantle_ws_add_user';
  acting uuid := "public"."mantle_ws_acting_login"(fn, owner);
  s record;
  tick boolean := coalesce(moderator, false);
BEGIN
  SELECT * INTO s FROM "public"."mantle_ws_user_seat"(fn, owner, ws, acting);
  -- An add to Admin is an Admin user, a Moderator there always.
  IF s.is_admin AND NOT tick THEN
    RAISE EXCEPTION 'mantle_ws:admin_workspace %: every Admin user is a Moderator of Admin', fn
      USING ERRCODE = '55000';
  END IF;
  IF acting IS NOT NULL AND NOT (s.moderator OR s.admin_users) THEN
    RAISE EXCEPTION 'mantle_ws:forbidden %: only a Moderator manages its users', fn
      USING ERRCODE = '42501';
  END IF;
  IF s.archived THEN
    RAISE EXCEPTION 'mantle_ws:archived %: the workspace is archived', fn USING ERRCODE = '55000';
  END IF;
  IF acting IS NOT NULL AND s.is_admin AND NOT s.admin_users THEN
    RAISE EXCEPTION 'mantle_ws:admin_users_only %: who is an Admin user needs the users area', fn
      USING ERRCODE = '42501';
  END IF;
  IF acting IS NOT NULL AND tick AND NOT s.admin_users THEN
    RAISE EXCEPTION 'mantle_ws:admin_only %: the Moderator tick needs the users area', fn
      USING ERRCODE = '42501';
  END IF;
  -- Who may add comes first: a caller who may not learns nothing of `login`.
  IF login IS NULL OR NOT EXISTS (SELECT 1 FROM "auth"."users" l WHERE l."id" = login) THEN
    RAISE EXCEPTION 'mantle_ws:user_not_found %: no such login', fn USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."workspace_users" u
              WHERE u."workspace_id" = ws AND u."login_id" = login) THEN
    RAISE EXCEPTION 'mantle_ws:already_user %: already a user of the workspace', fn
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator", "added_by")
  VALUES (ws, login, tick, acting);
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, 'user.add',
          jsonb_build_object('login', login, 'moderator', tick)
            || CASE WHEN login = acting THEN '{"self": true}'::jsonb ELSE '{}'::jsonb END);
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_remove_user"(owner uuid, ws uuid, login uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  fn constant text := 'mantle_ws_remove_user';
  acting uuid := "public"."mantle_ws_acting_login"(fn, owner);
  s record;
  self boolean := acting IS NOT NULL AND login = acting;
  had boolean;
BEGIN
  SELECT * INTO s FROM "public"."mantle_ws_user_seat"(fn, owner, ws, acting);
  -- Anyone may leave; removing another needs a Moderator or the users area.
  IF acting IS NOT NULL AND NOT self AND NOT (s.moderator OR s.admin_users) THEN
    RAISE EXCEPTION 'mantle_ws:forbidden %: only a Moderator manages its users', fn
      USING ERRCODE = '42501';
  END IF;
  IF s.archived THEN
    RAISE EXCEPTION 'mantle_ws:archived %: the workspace is archived', fn USING ERRCODE = '55000';
  END IF;
  SELECT u."moderator" INTO had FROM "public"."workspace_users" u
   WHERE u."workspace_id" = ws AND u."login_id" = login;
  IF login IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'mantle_ws:not_user %: not a user of the workspace', fn
      USING ERRCODE = 'P0002';
  END IF;
  IF s.is_admin THEN
    -- The anchor stays in Admin, and nobody removes themselves from it.
    IF login = owner THEN
      RAISE EXCEPTION 'mantle_ws:owner_stays_admin %: the anchor stays in Admin', fn
        USING ERRCODE = '42501';
    END IF;
    IF self THEN
      RAISE EXCEPTION 'mantle_ws:self_demote %: a login does not remove itself from Admin', fn
        USING ERRCODE = '42501';
    END IF;
    IF acting IS NOT NULL AND NOT s.admin_users THEN
      RAISE EXCEPTION 'mantle_ws:admin_users_only %: who is an Admin user needs the users area', fn
        USING ERRCODE = '42501';
    END IF;
  ELSIF acting IS NOT NULL AND NOT self AND had AND NOT s.admin_users THEN
    -- Removing a Moderator takes the tick away: the tick's own rule.
    RAISE EXCEPTION 'mantle_ws:admin_only %: removing a Moderator needs the users area', fn
      USING ERRCODE = '42501';
  END IF;
  IF had AND NOT EXISTS (
       SELECT 1 FROM "public"."workspace_users" u
        WHERE u."workspace_id" = ws AND u."moderator" AND u."login_id" <> login) THEN
    RAISE EXCEPTION 'mantle_ws:last_moderator %: the last Moderator of the workspace', fn
      USING ERRCODE = '55000';
  END IF;
  DELETE FROM "public"."workspace_users" u WHERE u."workspace_id" = ws AND u."login_id" = login;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, CASE WHEN self THEN 'user.leave' ELSE 'user.remove' END,
          jsonb_build_object('login', login));
END
$$;
--> statement-breakpoint
-- The switch's first part, 0286's body (its users step calls the bridge,
-- which is put back above).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_migrate_bridged"()
 RETURNS TABLE(section text, subject text, metric text, n bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  admin_ws uuid;
  team_ws uuid;
  clients bigint;
  client_items bigint;
  persona uuid;
  fails bigint;
BEGIN
  IF brain IS NULL THEN
    RETURN QUERY SELECT 'skip'::text, 'brain'::text, 'no brain anchor'::text, 1::bigint;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."workspaces" w WHERE w."owner_id" = brain AND w."bridge_key" = 'admin') THEN
    RETURN QUERY SELECT 'skip'::text, 'workspaces'::text, 'already migrated'::text, 1::bigint;
    RETURN;
  END IF;
  -- 21.9: clients are set up by hand, never migrated.
  SELECT count(*) INTO clients FROM auth.users u WHERE u."role" = 'client';
  SELECT count(*) INTO client_items FROM "public"."nodes" n
   WHERE n."owner_id" = brain
     AND (n."audience" = 'client' OR n."inherited_level" = 'client' OR n."embedded_level" = 'client');
  IF clients > 0 OR client_items > 0 THEN
    RAISE NOTICE 'workspaces not migrated: % client login(s), % client-level item(s); set them up by hand',
      clients, client_items;
    RETURN QUERY SELECT 'skip'::text, 'client logins'::text, 'count'::text, clients;
    RETURN QUERY SELECT 'skip'::text, 'client-level items'::text, 'count'::text, client_items;
    RETURN;
  END IF;

  -- Workspaces.
  INSERT INTO "public"."workspaces" ("owner_id", "name", "description", "is_admin", "bridge_key")
  VALUES (brain, 'Admin', 'Brain management, and everything made before workspaces.', true, 'admin')
  RETURNING "id" INTO admin_ws;
  INSERT INTO "public"."workspaces" ("owner_id", "name", "description", "admin_moderated", "bridge_key")
  VALUES (brain, 'Team', 'Work shared with the whole team.', true, 'team')
  RETURNING "id" INTO team_ws;

  -- Users: the login bridge, once per login (Admin for an admin login, 0286),
  -- then Team's users as the switch gave them before 0286 (every admin and
  -- member login a Moderator; the bridge did it then), so a brain switched
  -- now ends as every brain switched before, and the proof below sees the
  -- members' reach through Team. mantle_ws_migrate makes Team a normal
  -- workspace at the end (mantle_ws_team_normal).
  PERFORM "public"."mantle_bridge_login"(u."id") FROM auth.users u WHERE u."role" IN ('admin', 'member');
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
  SELECT team_ws, u."id", true FROM auth.users u
   WHERE u."role" IN ('admin', 'member')
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" a WHERE a."login_id" = u."id")
  ON CONFLICT ("workspace_id", "login_id") DO UPDATE SET "moderator" = true
   WHERE NOT "workspace_users"."moderator";

  -- Grants for every brain item.
  PERFORM "public"."mantle_bridge_apply"(ARRAY(
    SELECT n."id" FROM "public"."nodes" n WHERE n."owner_id" = brain));

  -- Facts learned in chat: admin only today, so Admin.
  PERFORM set_config('mantle.acl_internal', 'on', true);
  UPDATE "public"."facts" f SET "read_ws" = ARRAY[admin_ws]
   WHERE f."source_node_id" IS NULL AND f."owner_id" = brain AND f."read_ws" = '{}'::uuid[];
  PERFORM set_config('mantle.acl_internal', '', true);

  -- Assistants: the persona (the enabled admin-level responder, highest
  -- priority, a shared one before a login's own) on Admin; the team
  -- responder on Team. No Client workspace, so the client responder stays
  -- unattached.
  SELECT a."id" INTO persona FROM "public"."agents" a
   WHERE a."owner_id" = brain AND a."role" = 'responder' AND a."audience" = 'admin' AND a."enabled"
   ORDER BY a."priority" DESC, a."assigned_user_id" IS NOT NULL, a."created_at"
   LIMIT 1;
  IF persona IS NOT NULL THEN
    INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
    VALUES (admin_ws, 'assistant', persona::text, true);
  END IF;
  INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
  SELECT team_ws, 'assistant', a."id"::text, true
    FROM "public"."agents" a
   WHERE a."owner_id" = brain AND a."slug" = 'team-responder' AND a."audience" = 'team'
   LIMIT 1;

  -- Connectors (a tool group with an integration binding): every one on
  -- Admin with Write on (the owner's turns write today). On Team exactly the
  -- ones a member may use today (an enabled mcp connector at team level or
  -- below), Write on as today (a member's app run or MCP may call its
  -- unmarked tools; the read-only marks still apply per tool).
  INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
  SELECT admin_ws, 'connector', g."slug", true
    FROM "public"."tool_groups" g
   WHERE g."owner_id" = brain AND g."integration" IS NOT NULL;
  INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
  SELECT team_ws, 'connector', g."slug", true
    FROM "public"."tool_groups" g
   WHERE g."owner_id" = brain AND g."integration" ? 'mcp' AND g."enabled"
     AND g."audience" IN ('team', 'client', 'public');

  -- R3 backfill: only rows of agents attached outside Admin (NULL = Admin).
  UPDATE "public"."assistant_messages" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."chat_threads" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."runs" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."run_items" i SET "workspace_id" = r."workspace_id"
    FROM "public"."runs" r WHERE r."id" = i."run_id" AND r."workspace_id" = team_ws;
  UPDATE "public"."pending_tool_calls" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."traces" m SET "workspace_id" = a."workspace_id"
    FROM "public"."agents" a WHERE a."id" = m."agent_id" AND a."workspace_id" = team_ws;
  UPDATE "public"."tool_results" m SET "workspace_id" = t."workspace_id"
    FROM "public"."traces" t WHERE t."id" = m."trace_id" AND t."workspace_id" = team_ws;

  -- Any item the bridge left out of step (none expected on a fresh run) is
  -- brought to its level before the proof, so the proof sees the result.
  PERFORM "public"."mantle_bridge_apply"(ARRAY(SELECT "public"."mantle_bridge_drift_ids"()));

  -- The proof (9.4): nobody reads more than today, or nothing is written.
  SELECT coalesce(sum(d."n"), 0) INTO fails
    FROM "public"."mantle_ws_reach_diff"() d WHERE d."section" = 'reach-fail';
  IF fails > 0 THEN
    RAISE EXCEPTION 'workspaces migration: % item read(s) would be gained (reach diff); nothing written', fails
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT 'done', 'workspaces', 'count', count(*)
    FROM "public"."workspaces" w WHERE w."owner_id" = brain;
  RETURN QUERY SELECT 'done', 'workspace users', 'count', count(*) FROM "public"."workspace_users";
  RETURN QUERY
    SELECT 'done', 'grants to ' || w."name" ||
             CASE WHEN g."is_home" THEN ' (home)' WHEN g."excluded" THEN ' (removed here)' ELSE '' END,
           'count', count(*)
      FROM "public"."item_grants" g JOIN "public"."workspaces" w ON w."id" = g."workspace_id"
     GROUP BY 2;
  RETURN QUERY SELECT 'done', 'resources ' || r."type", 'count', count(*)
    FROM "public"."workspace_resources" r GROUP BY 2;
  RETURN QUERY
    SELECT 'done', 'admin responders left unattached', 'count', count(*)
      FROM "public"."agents" a
     WHERE a."owner_id" = brain AND a."role" = 'responder' AND a."audience" = 'admin'
       AND a."workspace_id" IS NULL;
  RETURN QUERY SELECT * FROM "public"."mantle_ws_reach_diff"() d WHERE d."section" <> 'reach-fail';
END
$function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate_bridged"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_area_rule"(login uuid, area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."workspaces" w
      JOIN "public"."workspace_users" u ON u."workspace_id" = w."id" AND u."login_id" = login
      JOIN "auth"."users" l ON l."id" = u."login_id" AND l."disabled_at" IS NULL
     WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin"
       AND w."archived_at" IS NULL
       AND area IN ('settings', 'users', 'assistants', 'connectors', 'keys')
       AND coalesce(u."limits" -> 'areas' ->> area, '') <> 'false')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_is_admin"(login uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."workspaces" w
      JOIN "public"."workspace_users" u ON u."workspace_id" = w."id" AND u."login_id" = login
      JOIN "auth"."users" l ON l."id" = u."login_id" AND l."disabled_at" IS NULL
     WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin"
       AND w."archived_at" IS NULL)
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_login_role"(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_scope_admin_facts"(text[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_admin_seat"(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_ws_exit_login"(text, uuid, uuid);
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0399 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790199900000;
