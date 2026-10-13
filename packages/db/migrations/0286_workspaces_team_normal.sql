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
-- 4. mantle_ws_migrate (the switch, last 0267): the chain of 0267, with
--    Team's users as the switch gave them before (every admin and member
--    login a Moderator: the login bridge did that until now), then
--    mantle_ws_team_normal(true). The switch still finds Team by its
--    bridge_key while it runs (the folds of an old brain's team items go
--    there), then Team ends normal, or gone when it holds nothing but the
--    admin logins (a new brain: its first owner only).
-- 5. mantle_ws_kind (0285): no 'team' kind. Team is 'other' (or 'private'
--    for none). The client keeps 'team' for an older brain.
-- 6. The reserved name: only "Admin" (workspaces_reserved_name_uq, 0255).
--    "Team" is a name like any other.
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
-- The switch (0267's chain), then Team ends normal or, holding nothing, gone.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_migrate"()
  RETURNS TABLE(section text, subject text, metric text, n bigint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY SELECT * FROM "public"."mantle_ws_migrate_bridged"();
  IF "public"."mantle_ws_skip_reason"() IS NOT NULL THEN RETURN; END IF;
  -- Team's users as the switch gave them before 0286 (the login bridge
  -- did it then; it gives Admin only now): every admin and member login a
  -- Moderator there, so a brain switched now ends as every brain switched
  -- before (its Moderators keep their ticks, decision 2.a). A new brain's
  -- Team then holds its admin logins only and is removed below.
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
  SELECT w."id", u."id", true
    FROM "public"."workspaces" w, auth.users u
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'team'
     AND u."role" IN ('admin', 'member')
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" a WHERE a."login_id" = u."id")
  ON CONFLICT ("workspace_id", "login_id") DO UPDATE SET "moderator" = true
   WHERE NOT "workspace_users"."moderator";
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
-- A workspace's kind for its default icon (0285): no 'team' any more.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_kind"(ws uuid)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE
           WHEN w."is_admin" THEN 'admin'
           WHEN EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                         WHERE p."workspace_id" = w."id") THEN 'private'
           ELSE 'other'
         END
    FROM "public"."workspaces" w
   WHERE w."id" = ws AND w."owner_id" = "public"."mantle_brain_id"()
     AND (NOT "public"."mantle_scope_active"()
          OR ws = ANY ("public"."mantle_scope_ws"())
          OR "public"."mantle_scope_has_admin"())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_kind"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Only "Admin" is reserved (0255 reserved "Admin" and "Team").
DROP INDEX IF EXISTS "public"."workspaces_reserved_name_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_reserved_name_uq"
  ON "public"."workspaces" ("owner_id", lower(btrim("name")))
  WHERE "archived_at" IS NULL AND lower(btrim("name")) = 'admin';
