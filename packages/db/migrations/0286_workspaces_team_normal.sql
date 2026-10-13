-- Team is a normal workspace (owner decision 2026-10-13, which reverses
-- plan Q1 of 2026-10-10). The only built-in workspace with rules of its own
-- is Admin. Nobody becomes a Moderator by themselves: an Admin user ticks
-- Moderator (server/web/lib/workspaces.ts), and the one who makes a
-- workspace is its first Moderator.
--
-- 1. mantle_ws_team_normal(drop_empty): the one place that ends Team's
--    built-in state. The Team workspace (bridge_key 'team') loses its
--    bridge_key and its admin_moderated flag, so no rule finds it any more:
--    it is renamed, archived and moderated like any workspace. Its name,
--    items, homes, grants, users, Moderator ticks, assistant, connectors
--    and landing page stay as they are. Its icon, when none was picked,
--    becomes the one its kind drew ('lucide:users', the client's default
--    for the old 'team' kind), so the switcher shows it as before. The
--    change is a workspace_events row (workspace.update, no actor).
--    With drop_empty (the switch of a brain onto workspaces, step 4) a Team
--    that holds nothing (no grant, no resource, no user but the Admin
--    users the switch put there, nothing else naming it) is removed
--    instead: a new brain has no Team workspace. A Team that holds
--    anything is kept as a normal workspace, as above.
-- 2. On this brain, now: Team is made normal, never removed (drop_empty
--    false), whatever it holds.
-- 3. mantle_bridge_login: a login's role gives the Admin workspace only. An
--    admin login joins Admin as a Moderator (the ON CONFLICT upgrade stays,
--    for Admin only: Admin users moderate Admin); a login that is not an
--    admin leaves Admin. Nobody is put in Team, or in any other workspace,
--    and nobody is made a Moderator of one: an invite and Add login give
--    a member login no workspace (its private one is made the first time
--    it needs it). Rows already in Team stay, with their ticks.
-- 4. The switch of a brain not on workspaces yet: mantle_ws_migrate_bridged
--    (0251, renamed by 0261) gives Team its users as before (every admin
--    and member login a Moderator: the login bridge did that until now),
--    and mantle_ws_migrate (last 0267) ends its chain with
--    mantle_ws_team_normal(true). The switch still finds Team by its
--    bridge_key while it runs (the folds of an old brain's team items go
--    there), then Team ends normal, or gone when it holds nothing but the
--    admin logins (a new brain: its first owner only).
-- 5. mantle_ws_kind (0285): no 'team' kind. Team is 'other' (or 'private'
--    for none). The client keeps 'team' for an older brain.
-- 6. The reserved name: only "Admin" (workspaces_reserved_name_uq, 0255).
--    "Team" is a name like any other.
-- 7. One class of a workspace, mantle_ws_class(ws): admin, private,
--    former (a Former user workspace) or other, for a workspace of this
--    brain the caller may name (one of the scope's, or any when the scope
--    holds Admin, the rule of mantle_folder_grant_rows, 0279; on the system
--    pool any of this brain). Definer, as mantle_ws_kind was: the workspace
--    role reads neither private_workspaces nor former_user_workspaces. On it:
--    mantle_ws_kind (its icon kind), mantle_ws_any_shared(ws[]) ("shared":
--    of class other; the grant reads and firstSharedWorkspaceId ask it),
--    and mantle_ws_any_holder(ws[]) (a live holder beyond Admin, private and
--    Former user ones included: an app's MCP reach). Yes or no only, never
--    a name.
--
-- The functions that still read bridge_key = 'team' (the bridges, the
-- switch's folds, mantle_brain_team_ws, mantle_ws_attach_assistants) find
-- nothing after this migration and do nothing for Team: the switch's
-- functions only run on a brain that is not on workspaces yet, which has
-- no Team until the switch makes one. No released migration is edited.
--
-- No LLM work, no notify, no backfill beyond the one workspaces row per
-- brain. The lock is taken first and never waited for past 30 s behind
-- live traffic (as 0283, 0285): the migration fails and is retried rather
-- than queueing every reader behind it. Re-runnable: CREATE OR REPLACE,
-- DROP INDEX IF EXISTS, and step 2 finds no Team a second time.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
LOCK TABLE "public"."workspaces" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_team_normal"(drop_empty boolean)
  RETURNS TABLE(section text, subject text, metric text, n bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  team_ws uuid;
  had_icon boolean;
BEGIN
  IF brain IS NULL THEN RETURN; END IF;
  SELECT w."id", w."icon" IS NOT NULL INTO team_ws, had_icon FROM "public"."workspaces" w
   WHERE w."owner_id" = brain AND w."bridge_key" = 'team'
   FOR UPDATE;
  IF team_ws IS NULL THEN RETURN; END IF;
  IF drop_empty
     AND NOT EXISTS (SELECT 1 FROM "public"."item_grants" g WHERE g."workspace_id" = team_ws)
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_resources" r
                      WHERE r."workspace_id" = team_ws)
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_users" u
                      WHERE u."workspace_id" = team_ws
                        AND NOT EXISTS (
                          SELECT 1 FROM "public"."workspace_users" au
                            JOIN "public"."workspaces" aw
                              ON aw."id" = au."workspace_id" AND aw."is_admin"
                           WHERE au."login_id" = u."login_id" AND aw."owner_id" = brain)) THEN
    BEGIN
      -- Its own events (the switch's) go with it; its user rows cascade.
      -- Anything else that names it (an agent, a chat, a run, a home of the
      -- review states) refuses the delete: then it is kept, below.
      DELETE FROM "public"."workspace_events" e WHERE e."workspace_id" = team_ws;
      DELETE FROM "public"."workspaces" w WHERE w."id" = team_ws;
      RETURN QUERY SELECT 'team'::text, 'Team workspace'::text, 'not kept (held nothing)'::text,
                          1::bigint;
      RETURN;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END IF;
  UPDATE "public"."workspaces" w
     SET "bridge_key" = NULL, "admin_moderated" = false,
         "icon" = coalesce(w."icon", 'lucide:users'), "updated_at" = now()
   WHERE w."id" = team_ws;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (team_ws, NULL, 'workspace.update',
          jsonb_build_object('builtIn', false, 'by', 'migration 0286')
            || CASE WHEN had_icon THEN '{}'::jsonb
                    ELSE jsonb_build_object('icon', 'lucide:users') END);
  RETURN QUERY SELECT 'team'::text, 'Team workspace'::text, 'made a normal workspace'::text,
                      1::bigint;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_team_normal"(boolean) FROM PUBLIC;
--> statement-breakpoint
SELECT * FROM "public"."mantle_ws_team_normal"(false);
--> statement-breakpoint
-- The login bridge (0251, last 0272): the Admin workspace only.
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
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_login"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- The switch's first part (0251, renamed by 0261): only its user step
-- changes. Team's users are put there by the switch itself now, as the
-- login bridge put them before.
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
-- The switch (0267's chain), then Team ends normal or, holding nothing, gone.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_migrate"()
  RETURNS TABLE(section text, subject text, metric text, n bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
BEGIN
  -- A brain already on workspaces: nothing to do (the chain below is for
  -- the switch only; its proofs read Team by the bridge key 0286 clears).
  IF EXISTS (SELECT 1 FROM "public"."workspaces" w
              WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin') THEN
    RETURN QUERY SELECT 'skip'::text, 'workspaces'::text, 'already migrated'::text, 1::bigint;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM "public"."mantle_ws_migrate_bridged"();
  IF "public"."mantle_ws_skip_reason"() IS NOT NULL THEN RETURN; END IF;
  PERFORM "public"."mantle_ws_switch_off"();
  RETURN QUERY SELECT 'bridge off'::text, b."step", 'count'::text, b."n"
                 FROM "public"."mantle_ws_bridge_off"() b;
  RETURN QUERY SELECT * FROM "public"."mantle_ws_switch_guard"();
  -- The review states (0264) and the spaces fold (W6b): the fold runs
  -- mantle_ws_review_off() first.
  RETURN QUERY SELECT 'spaces fold: ' || r."section", r."subject", r."metric", r."n"
                 FROM "public"."mantle_ws_spaces_fold"() r;
  -- Team is a normal workspace (0286), or none when it holds nothing.
  RETURN QUERY SELECT * FROM "public"."mantle_ws_team_normal"(true);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate"() FROM PUBLIC;
--> statement-breakpoint
-- The one class of a workspace (7): 'admin', 'private', 'former' (a Former
-- user workspace) or 'other', for a workspace of this brain the caller may
-- name; null for any other id. Every reader below asks it, so the kinds and
-- "shared" and "holder" never disagree. Not granted to any role: only the
-- definers below call it.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_class"(ws uuid)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE
           WHEN w."is_admin" THEN 'admin'
           WHEN EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                         WHERE p."workspace_id" = w."id") THEN 'private'
           WHEN EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f
                         WHERE f."workspace_id" = w."id") THEN 'former'
           ELSE 'other'
         END
    FROM "public"."workspaces" w
   WHERE w."id" = ws AND w."owner_id" = "public"."mantle_brain_id"()
     AND (NOT "public"."mantle_scope_active"()
          OR ws = ANY ("public"."mantle_scope_ws"())
          OR "public"."mantle_scope_has_admin"())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_class"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- A workspace's kind for its default icon (0285): no 'team' any more. The
-- class, with a Former user workspace drawn as 'other' (the plain icon):
-- the client knows no 'former' kind.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_kind"(ws uuid)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE c WHEN 'former' THEN 'other' ELSE c END
    FROM "public"."mantle_ws_class"(ws) AS c
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_kind"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- The one meaning of "a shared workspace" (7): any of `ws` is of class
-- 'other'.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_any_shared"(ws uuid[])
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM unnest(ws) AS i(id)
                  WHERE "public"."mantle_ws_class"(i."id") = 'other')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_any_shared"(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_any_shared"(uuid[]) TO "mantle_view_user";
--> statement-breakpoint
-- A live holder beyond Admin (7): any of `ws` is live and not Admin; a
-- private or Former user workspace holds too (its user runs and reaches
-- the item there). The rule of an app run's holders (appRunHolders,
-- liveHolderBeyondAdminSql), for a reader in a scope: an app's MCP reach.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_any_holder"(ws uuid[])
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."id" = ANY (ws) AND w."archived_at" IS NULL
                    AND "public"."mantle_ws_class"(w."id") <> 'admin')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_any_holder"(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_any_holder"(uuid[]) TO "mantle_view_user";
--> statement-breakpoint
-- The public demo's SELECT-only reader serves owner reads: the same, as it
-- got mantle_ws_kind (0285).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_any_shared"(uuid[]) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_any_holder"(uuid[]) TO demo_reader;
  END IF;
END
$$;
--> statement-breakpoint
-- Only "Admin" is reserved (0255 reserved "Admin" and "Team").
DROP INDEX IF EXISTS "public"."workspaces_reserved_name_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_reserved_name_uq"
  ON "public"."workspaces" ("owner_id", lower(btrim("name")))
  WHERE "archived_at" IS NULL AND lower(btrim("name")) = 'admin';
