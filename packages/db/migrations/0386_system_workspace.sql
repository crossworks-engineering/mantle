-- The System workspace (owner decisions 2026-11-19, dev brain page 9581c43e):
-- a second special workspace, a subset of Admin. Its users ("super admins")
-- hold the brain's technical areas (settings, assistants, connectors, keys);
-- Admin keeps the users area for every Admin user.
--
-- 1. mantle_ws_system_id(o): the brain's System workspace (an id), as
--    mantle_ws_admin_id (0279) answers Admin's. Marked by bridge_key
--    'system' (workspaces_bridge_key_uq: one per brain); no new column.
--    mantle_view_user's.
-- 2. mantle_ws_ensure_system(): makes System when the brain has an Admin
--    workspace and no System yet, with every user of Admin (enabled or not)
--    as its user, ticked, one user.add event each (no actor, by '0391').
--    Else nothing. Returns how many users it seated. Run once below, and at
--    the end of mantle_ws_migrate (a fresh brain's switch, test fixtures).
--    Granted to no role.
-- 3. mantle_area_rule(login, area) (0330's body plus one line): the Admin
--    seat as before (enabled, the area not turned off on the Admin row), AND
--    the area is 'users' or the login is a user of the live System
--    workspace. Every area reader (mantle_scope_has_area, mantle_login_areas,
--    mantle_scope_admin_facts, mantle_login_area) goes through it, so this
--    is the one change. The role column still means Admin membership only.
-- 4. The workspace user definers (0330 and 0307 bodies, byte for byte, plus
--    the lines named here), with sys := ws is the brain's System workspace:
--    - mantle_ws_add_user: on System only a System user adds (403
--      system_users_only, the Admin users area's add-anyone too); the login
--      added must be an Admin user (55000 not_admin_user); the tick is
--      always on there (stored true, never a choice, so the tick's users
--      area rule does not apply on System).
--    - mantle_ws_remove_user: on System anyone may leave; removing another
--      needs a System user (403 system_users_only), in place of the tick's
--      users area rule; the anchor stays in System as in Admin
--      (owner_stays_admin); the last System user is the existing
--      last_moderator answer. On Admin: the login leaves System too, in the
--      same transaction, with a user.remove event there ({via: 'admin'}).
--    - mantle_ws_set_moderator: the tick on System is never cleared, as on
--      Admin (admin_workspace).
--    - mantle_ws_archive: System is never archived (archive_admin).
--    - mantle_ws_update_about: System keeps its name (admin_keeps_name).
-- 5. mantle_ws_last_admin_mod_trg (0241): fires for System too, so the last
--    System user is never removed by any path (a login's delete included).
-- 6. mantle_ws_system_work (0321, as 0322 left it): one more pair,
--    ('system:system-add', 'mantle_ws_add_user'): the operator's recovery
--    command (server/web system:add) puts a login in Admin, then in System,
--    as system work.
-- 7. mantle_ws_migrate (0286): mantle_ws_ensure_system() at its end, so a
--    brain switched after this ends as one switched before.
-- 8. System is made here once, with a NOTICE of how many users it seated.
--
-- No table, column, CHECK or trigger is added. No LLM work.
-- Revert: packages/db/rollback/0386_system_workspace.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- 1. The brain's System workspace: an id only, as mantle_ws_admin_id.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_system_id"(o uuid)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT w."id" FROM "public"."workspaces" w WHERE w."owner_id" = o AND w."bridge_key" = 'system' LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_system_id"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_system_id"(uuid) TO "mantle_view_user";
--> statement-breakpoint
-- 2. System, once: every user of Admin, ticked. Two at once make one (the
-- bridge key's unique index; the second seats nobody).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_ensure_system"()
  RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  admin_ws uuid;
  sys_ws uuid;
  seated integer := 0;
BEGIN
  IF brain IS NULL THEN RETURN 0; END IF;
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = brain AND w."is_admin";
  IF admin_ws IS NULL THEN RETURN 0; END IF;
  INSERT INTO "public"."workspaces" ("owner_id", "name", "description", "bridge_key", "icon")
  VALUES (brain, 'System',
          'The brain''s models, assistants, connectors and keys. Only an Admin user can be added.',
          'system', 'lucide:cpu')
  ON CONFLICT ("owner_id", "bridge_key") WHERE "bridge_key" IS NOT NULL DO NOTHING
  RETURNING "id" INTO sys_ws;
  IF sys_ws IS NULL THEN RETURN 0; END IF;
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
  SELECT sys_ws, u."login_id", true FROM "public"."workspace_users" u
   WHERE u."workspace_id" = admin_ws;
  GET DIAGNOSTICS seated = ROW_COUNT;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  SELECT sys_ws, NULL, 'user.add',
         jsonb_build_object('login', u."login_id", 'moderator', true, 'by', '0391')
    FROM "public"."workspace_users" u
   WHERE u."workspace_id" = sys_ws;
  RETURN seated;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_ensure_system"() FROM PUBLIC;
--> statement-breakpoint
-- 3. The area rule: the Admin seat, and System for every area but users.
CREATE OR REPLACE FUNCTION "public"."mantle_area_rule"(login uuid, area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."mantle_admin_seat"(login) s
     WHERE s."enabled"
       AND area IN ('settings', 'users', 'assistants', 'connectors', 'keys')
       AND coalesce(s."limits" -> 'areas' ->> area, '') <> 'false'
       AND (area = 'users'
            OR EXISTS (SELECT 1 FROM "public"."workspaces" w
                         JOIN "public"."workspace_users" u
                           ON u."workspace_id" = w."id" AND u."login_id" = login
                        WHERE w."owner_id" = "public"."mantle_brain_id"()
                          AND w."bridge_key" = 'system' AND w."archived_at" IS NULL)))
$$;
--> statement-breakpoint
-- 4. Add `login` to `ws` (0330's body; the System lines are marked).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_add_user"(
  owner uuid, ws uuid, login uuid, moderator boolean)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  fn constant text := 'mantle_ws_add_user';
  -- The exit's acting login with no scope (mantle_ws_exit_login), else
  -- 0307's: the scope's login, or system work.
  exit_login uuid := "public"."mantle_ws_exit_login"(fn, owner, ws);
  acting uuid := coalesce(exit_login, "public"."mantle_ws_acting_login"(fn, owner));
  s record;
  tick boolean := coalesce(moderator, false);
  -- System (0391): only its users add, only an Admin user, always ticked.
  sys boolean := coalesce(ws = "public"."mantle_ws_system_id"(owner), false);
BEGIN
  SELECT * INTO s FROM "public"."mantle_ws_user_seat"(fn, owner, ws, acting);
  -- With no scope the users area is the exit's login's own, by the area
  -- rule (a scope asks its own, mantle_scope_has_area).
  IF exit_login IS NOT NULL THEN
    s.admin_users := "public"."mantle_area_rule"(exit_login, 'users');
  END IF;
  -- An add to Admin is an Admin user, a Moderator there always.
  IF s.is_admin AND NOT tick THEN
    RAISE EXCEPTION 'mantle_ws:admin_workspace %: every Admin user is a Moderator of Admin', fn
      USING ERRCODE = '55000';
  END IF;
  IF acting IS NOT NULL AND NOT (s.moderator OR s.admin_users) THEN
    RAISE EXCEPTION 'mantle_ws:forbidden %: only a Moderator manages its users', fn
      USING ERRCODE = '42501';
  END IF;
  IF sys AND acting IS NOT NULL AND NOT s.moderator THEN
    RAISE EXCEPTION 'mantle_ws:system_users_only %: only a System user adds to System', fn
      USING ERRCODE = '42501';
  END IF;
  IF s.archived THEN
    RAISE EXCEPTION 'mantle_ws:archived %: the workspace is archived', fn USING ERRCODE = '55000';
  END IF;
  IF acting IS NOT NULL AND s.is_admin AND NOT s.admin_users THEN
    RAISE EXCEPTION 'mantle_ws:admin_users_only %: who is an Admin user needs the users area', fn
      USING ERRCODE = '42501';
  END IF;
  IF acting IS NOT NULL AND tick AND NOT sys AND NOT s.admin_users THEN
    RAISE EXCEPTION 'mantle_ws:admin_only %: the Moderator tick needs the users area', fn
      USING ERRCODE = '42501';
  END IF;
  -- Who may add comes first: a caller who may not learns nothing of `login`.
  IF login IS NULL OR NOT EXISTS (SELECT 1 FROM "auth"."users" l WHERE l."id" = login) THEN
    RAISE EXCEPTION 'mantle_ws:user_not_found %: no such login', fn USING ERRCODE = 'P0002';
  END IF;
  IF sys AND NOT "public"."mantle_login_is_admin"(login) THEN
    RAISE EXCEPTION 'mantle_ws:not_admin_user %: only an Admin user is added to System', fn
      USING ERRCODE = '55000';
  END IF;
  IF sys THEN tick := true; END IF;
  IF EXISTS (SELECT 1 FROM "public"."workspace_users" u
              WHERE u."workspace_id" = ws AND u."login_id" = login) THEN
    RAISE EXCEPTION 'mantle_ws:already_user %: already a user of the workspace', fn
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator", "added_by")
  VALUES (ws, login, tick, acting);
  -- The role follows membership (S8b): a user of Admin is role admin, in
  -- this transaction, so the column never says other than the row.
  IF s.is_admin THEN
    UPDATE "auth"."users" SET "role" = 'admin' WHERE "id" = login;
  END IF;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, 'user.add',
          jsonb_build_object('login', login, 'moderator', tick)
            || CASE WHEN login = acting THEN '{"self": true}'::jsonb ELSE '{}'::jsonb END);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_add_user"(uuid, uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
-- 4. Remove `login` from `ws` (0330's body; the System lines are marked).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_remove_user"(owner uuid, ws uuid, login uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  fn constant text := 'mantle_ws_remove_user';
  -- The exit's acting login with no scope (mantle_ws_exit_login), else
  -- 0307's: the scope's login, or system work.
  exit_login uuid := "public"."mantle_ws_exit_login"(fn, owner, ws);
  acting uuid := coalesce(exit_login, "public"."mantle_ws_acting_login"(fn, owner));
  s record;
  self boolean := acting IS NOT NULL AND login = acting;
  had boolean;
  -- System (0391): anyone leaves, only its users remove another.
  sys_ws uuid := "public"."mantle_ws_system_id"(owner);
  sys boolean := coalesce(ws = sys_ws, false);
BEGIN
  SELECT * INTO s FROM "public"."mantle_ws_user_seat"(fn, owner, ws, acting);
  -- With no scope the users area is the exit's login's own, by the area
  -- rule (a scope asks its own, mantle_scope_has_area).
  IF exit_login IS NOT NULL THEN
    s.admin_users := "public"."mantle_area_rule"(exit_login, 'users');
  END IF;
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
  ELSIF sys THEN
    -- The anchor stays in System too; removing another needs a System user.
    IF login = owner THEN
      RAISE EXCEPTION 'mantle_ws:owner_stays_admin %: the anchor stays in Admin and System', fn
        USING ERRCODE = '42501';
    END IF;
    IF acting IS NOT NULL AND NOT self AND NOT s.moderator THEN
      RAISE EXCEPTION 'mantle_ws:system_users_only %: only a System user removes from System', fn
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
  -- The role follows membership (S8b): a login no longer in Admin is role
  -- member, in this transaction.
  IF s.is_admin THEN
    UPDATE "auth"."users" SET "role" = 'member' WHERE "id" = login;
    -- Out of Admin is out of System (0391); the guard trigger keeps its
    -- last user.
    DELETE FROM "public"."workspace_users" u WHERE u."workspace_id" = sys_ws AND u."login_id" = login;
    IF FOUND THEN
      INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
      VALUES (sys_ws, acting, 'user.remove', jsonb_build_object('login', login, 'via', 'admin'));
    END IF;
  END IF;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, CASE WHEN self THEN 'user.leave' ELSE 'user.remove' END,
          jsonb_build_object('login', login));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_remove_user"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- 4. Tick or clear `login`'s Moderator tick on `ws` (0307's body; System
-- keeps every tick, as Admin).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_set_moderator"(
  owner uuid, ws uuid, login uuid, moderator boolean, by text)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  fn constant text := 'mantle_ws_set_moderator';
  acting uuid := "public"."mantle_ws_acting_login"(fn, owner);
  s record;
  tick boolean;
  had boolean;
  sys boolean := coalesce(ws = "public"."mantle_ws_system_id"(owner), false);
BEGIN
  IF moderator IS NULL THEN
    RAISE EXCEPTION 'mantle_ws:invalid %: moderator is true or false', fn USING ERRCODE = '22023';
  END IF;
  tick := moderator;
  SELECT * INTO s FROM "public"."mantle_ws_user_seat"(fn, owner, ws, acting);
  IF acting IS NOT NULL AND NOT (s.moderator OR s.admin_users) THEN
    RAISE EXCEPTION 'mantle_ws:forbidden %: only a Moderator manages its users', fn
      USING ERRCODE = '42501';
  END IF;
  IF s.archived THEN
    RAISE EXCEPTION 'mantle_ws:archived %: the workspace is archived', fn USING ERRCODE = '55000';
  END IF;
  IF acting IS NOT NULL AND NOT s.admin_users THEN
    RAISE EXCEPTION 'mantle_ws:admin_only %: the Moderator tick needs the users area', fn
      USING ERRCODE = '42501';
  END IF;
  IF (s.is_admin OR sys) AND NOT tick THEN
    RAISE EXCEPTION 'mantle_ws:admin_workspace %: every Admin user is a Moderator of Admin', fn
      USING ERRCODE = '55000';
  END IF;
  SELECT u."moderator" INTO had FROM "public"."workspace_users" u
   WHERE u."workspace_id" = ws AND u."login_id" = login;
  IF login IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'mantle_ws:not_user %: not a user of the workspace', fn
      USING ERRCODE = 'P0002';
  END IF;
  IF had = tick THEN RETURN; END IF;
  IF NOT tick AND NOT EXISTS (
       SELECT 1 FROM "public"."workspace_users" u
        WHERE u."workspace_id" = ws AND u."moderator" AND u."login_id" <> login) THEN
    RAISE EXCEPTION 'mantle_ws:last_moderator %: the last Moderator of the workspace', fn
      USING ERRCODE = '55000';
  END IF;
  UPDATE "public"."workspace_users" u SET "moderator" = tick
   WHERE u."workspace_id" = ws AND u."login_id" = login;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, 'user.moderator',
          jsonb_build_object('login', login, 'moderator', tick)
            || CASE WHEN by IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('by', by) END);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_set_moderator"(uuid, uuid, uuid, boolean, text) FROM PUBLIC;
--> statement-breakpoint
-- 4. The archive (0309's body; System is never archived, as Admin).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_archive"(owner uuid, ws uuid)
  RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  fn constant text := 'mantle_ws_archive';
  acting uuid := "public"."mantle_ws_acting_login"(fn, owner);
  heads_first uuid[];
  heads_later uuid[];
  s record;
  c record;
BEGIN
  -- Every item the workspace holds but is not the home of, the ones the
  -- acting login cannot open included: their heads are the first lock.
  heads_first := ARRAY(SELECT g."node_id" FROM "public"."item_grants" g
                  WHERE g."workspace_id" = ws AND NOT g."is_home");
  PERFORM "public"."mantle_lock_heads"(heads_first, 'update');
  SELECT * INTO s FROM "public"."mantle_ws_user_seat"(fn, owner, ws, acting);
  IF NOT (s.moderator OR s.admin_users) THEN
    RAISE EXCEPTION 'mantle_ws:archive_forbidden %: only a Moderator archives it', fn
      USING ERRCODE = '42501';
  END IF;
  IF s.is_admin OR coalesce(ws = "public"."mantle_ws_system_id"(owner), false) THEN
    RAISE EXCEPTION 'mantle_ws:archive_admin %: the Admin and System workspaces are never archived', fn
      USING ERRCODE = '55000';
  END IF;
  IF s.archived THEN
    RAISE EXCEPTION 'mantle_ws:archived %: the workspace is archived', fn USING ERRCODE = '55000';
  END IF;
  -- Every grant of the workspace, counted here as the owner: never through
  -- a reader held to the scope's settings (a scope may name the acting
  -- login's workspaces but not its Moderator seats, and would count 0).
  SELECT count(*) FILTER (WHERE g."is_home")::int AS "items",
         count(*) FILTER (WHERE NOT g."is_home" AND NOT g."excluded")::int AS "grants",
         count(*) FILTER (WHERE g."excluded")::int AS "exclusions"
    INTO c
    FROM "public"."item_grants" g
   WHERE g."workspace_id" = ws;
  IF coalesce(c."items", 0) > 0 THEN
    RAISE EXCEPTION 'mantle_ws:holds_items %: % item(s) have their home in the workspace', fn, c."items"
      USING ERRCODE = '55000';
  END IF;
  heads_later := ARRAY(SELECT g."node_id" FROM "public"."item_grants" g
                  WHERE g."workspace_id" = ws AND NOT g."is_home"
                    AND NOT (g."node_id" = ANY (heads_first)));
  IF cardinality(heads_later) > 0 THEN
    PERFORM "public"."mantle_lock_heads_more"(heads_later);
  END IF;
  DELETE FROM "public"."item_grants" g WHERE g."workspace_id" = ws AND NOT g."is_home";
  UPDATE "public"."workspaces" w SET "archived_at" = now(), "updated_at" = now()
   WHERE w."id" = ws;
  -- Both kinds of row the delete drops: shares, and the "removed here"
  -- exclusions against a folder's grant.
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, 'workspace.archive',
          jsonb_build_object('grantsDropped', coalesce(c."grants", 0),
                             'exclusionsDropped', coalesce(c."exclusions", 0)));
  RETURN jsonb_build_object('items', coalesce(c."items", 0), 'grants', coalesce(c."grants", 0));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_archive"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- 4. The name, description and look (0309's body; System keeps its name, as
-- Admin).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_update_about"(owner uuid, ws uuid, patch jsonb)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  fn constant text := 'mantle_ws_update_about';
  acting uuid := "public"."mantle_ws_acting_login"(fn, owner);
  s record;
  cur record;
  p jsonb := coalesce(patch, '{}'::jsonb);
  changed jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'mantle_ws:invalid %: the patch is an object', fn USING ERRCODE = '22023';
  END IF;
  IF (p ? 'name' AND jsonb_typeof(p -> 'name') <> 'string')
     OR (p ? 'description' AND jsonb_typeof(p -> 'description') <> 'string')
     OR (p ? 'color' AND jsonb_typeof(p -> 'color') NOT IN ('string', 'null'))
     OR (p ? 'icon' AND jsonb_typeof(p -> 'icon') NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'mantle_ws:invalid %: name and description are text, color and icon text or null', fn
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM "public"."mantle_ws_user_seat"(fn, owner, ws, acting);
  IF s.archived THEN
    RAISE EXCEPTION 'mantle_ws:archived %: the workspace is archived', fn USING ERRCODE = '55000';
  END IF;
  IF NOT (s.moderator OR s.admin_users) THEN
    RAISE EXCEPTION 'mantle_ws:about_forbidden %: only a Moderator changes it', fn
      USING ERRCODE = '42501';
  END IF;
  SELECT w."name", w."description", w."color", w."icon" INTO cur
    FROM "public"."workspaces" w WHERE w."id" = ws;
  IF p ? 'name' AND (p ->> 'name') IS DISTINCT FROM cur."name" THEN
    -- Admin keeps its name: a renamed Admin would free "Admin" for anyone,
    -- and a later clash would tell them it exists. System keeps its name too.
    IF s.is_admin OR coalesce(ws = "public"."mantle_ws_system_id"(owner), false) THEN
      RAISE EXCEPTION 'mantle_ws:admin_keeps_name %: the Admin and System workspaces keep their names', fn
        USING ERRCODE = '55000';
    END IF;
    IF lower(btrim(p ->> 'name')) = 'admin' THEN
      RAISE EXCEPTION 'mantle_ws:reserved_name %: Admin is the built-in workspace''s name', fn
        USING ERRCODE = '55000';
    END IF;
    changed := changed || jsonb_build_object('name', p -> 'name');
  END IF;
  IF p ? 'description' AND (p ->> 'description') IS DISTINCT FROM cur."description" THEN
    changed := changed || jsonb_build_object('description', p -> 'description');
  END IF;
  IF p ? 'color' AND (p ->> 'color') IS DISTINCT FROM cur."color" THEN
    changed := changed || jsonb_build_object('color', p -> 'color');
  END IF;
  IF p ? 'icon' AND (p ->> 'icon') IS DISTINCT FROM cur."icon" THEN
    changed := changed || jsonb_build_object('icon', p -> 'icon');
  END IF;
  IF changed = '{}'::jsonb THEN RETURN; END IF;
  UPDATE "public"."workspaces" w SET
    "name" = CASE WHEN changed ? 'name' THEN changed ->> 'name' ELSE w."name" END,
    "description" = CASE WHEN changed ? 'description' THEN changed ->> 'description'
                         ELSE w."description" END,
    "color" = CASE WHEN changed ? 'color' THEN changed ->> 'color' ELSE w."color" END,
    "icon" = CASE WHEN changed ? 'icon' THEN changed ->> 'icon' ELSE w."icon" END,
    "updated_at" = now()
   WHERE w."id" = ws;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, 'workspace.update', changed);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_update_about"(uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
-- 5. The Admin workspace keeps at least one Moderator, and System at least
-- one user (all its users are ticked). Checked at commit with the workspace
-- row locked, so two transactions that each remove a different Moderator
-- cannot both pass (audit L8: write skew).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_last_admin_mod_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  ws uuid := OLD."workspace_id";
  is_admin_ws boolean;
  is_system_ws boolean;
BEGIN
  SELECT w."is_admin" OR coalesce(w."bridge_key" = 'system', false),
         coalesce(w."bridge_key" = 'system', false)
    INTO is_admin_ws, is_system_ws
    FROM "public"."workspaces" w WHERE w."id" = ws;
  -- A real write, not only a row lock: two transactions that each remove a
  -- different Moderator then conflict under REPEATABLE READ and SERIALIZABLE
  -- too (a serialization failure), not only under READ COMMITTED (re-audit
  -- LOW c).
  IF coalesce(is_admin_ws, false) THEN
    UPDATE "public"."workspaces" SET "updated_at" = now() WHERE "id" = ws;
  END IF;
  IF coalesce(is_admin_ws, false)
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_users" u
                      WHERE u."workspace_id" = ws AND u."moderator") THEN
    -- System's own words (the last System user leaving by any path: a
    -- leave, a removal from Admin, a login delete), so the routes answer
    -- last_system_user, not Admin's last Moderator.
    IF is_system_ws THEN
      RAISE EXCEPTION 'mantle_ws:last_system_user the System workspace keeps at least one user'
        USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'the Admin and System workspaces need at least one Moderator' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- 6. The system work allowlist (0321's body, its actor read as 0322 rewrote
-- it, one more pair: the operator's recovery command, server/web system:add).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_system_work"(fn text)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_scope_login_id"() IS NULL
     AND NOT "public"."mantle_scope_active"()
     AND coalesce(current_setting('mantle.write_mode', true), '') <> 'ro'
     AND "public"."mantle_system_session"()
     AND session_user <> 'mantle_system_narrow'
     AND (CASE WHEN current_setting('role') = 'none' THEN session_user::text
               ELSE current_setting('role') END) IN (
           SELECT x FROM unnest(ARRAY['mantle_system', 'mantle_runtime', 'mantle_owner',
                                      current_user::text]) x
           UNION ALL
           SELECT r.rolname::text FROM pg_catalog.pg_roles r WHERE r.rolsuper)
     AND (CASE WHEN current_setting('role') = 'none' THEN session_user::text
               ELSE current_setting('role') END) <> 'mantle_system_narrow'
     AND (coalesce("public"."mantle_identity_actor"(), ''), fn) IN (
           ('system:ws-clear-ticks', 'mantle_ws_set_moderator'),
           ('system:boot:migrate-workspaces', 'mantle_ws_attach_assistants'),
           ('system:snapshot-copies', 'mantle_file_restamp_home'),
           ('system:system-add', 'mantle_ws_add_user'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_system_work"(text) FROM PUBLIC;
--> statement-breakpoint
-- 7. The switch (0286's body), System made at its end.
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
  -- System (0391): every Admin user, as a brain switched before has it.
  PERFORM "public"."mantle_ws_ensure_system"();
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate"() FROM PUBLIC;
--> statement-breakpoint
-- 8. System, once, on a brain already switched (numbers only).
DO $$
DECLARE
  seated integer := "public"."mantle_ws_ensure_system"();
BEGIN
  RAISE NOTICE 'mantle System workspace: % Admin user(s) seated', seated;
END
$$;
