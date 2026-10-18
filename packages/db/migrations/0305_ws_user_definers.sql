-- The users of a workspace in SQL (workspaces arch plan v3.2, S2a a1): who
-- may add a user, tick or clear Moderator, and remove a user is decided in
-- the database, by the acting login, never by the pool a write runs on.
--
-- 1. mantle_ws_system_work(): the one "system work" a workspace definer
--    takes from a caller with no acting login. True only when no acting
--    login is set (mantle_scope_login_id() is null, no scope is open),
--    mantle.write_mode is not 'ro', and mantle.actor is EXACTLY one string
--    of the allowlist below, one per real caller, each added in the release
--    that moves its caller (at most five, plan rule 6):
--      - 'system:ws-clear-ticks': pnpm -C server/web ws:clear-member-ticks
--        (workspace-ticks.ts clearMemberTicks, systemWork('ws-clear-ticks')).
--    Never "an actor starting with system:": asSystem binds system:<reason>
--    as systemWork does (system:workspace-write, system:admin-area,
--    system:http:admin-area, ...), so a prefix would take every exit.
--    system:operator:* (mantle_operator_actor, 0275) is refused too: a hand
--    repair uses the named command, or writes as the superuser.
--    PUBLIC revoked and granted to no role: only the definers below (and
--    the ones that follow them) call it, as its owner.
-- 2. mantle_ws_acting_login(fn, owner): the acting login of a workspace
--    definer (mantle_scope_login_id: the scope's login on the write role, or
--    a system-pool transaction with a request's write scope set), an enabled
--    login, on its brain. With none: NULL when mantle_ws_system_work(), else
--    refused (42501). Private, as 1.
-- 3. mantle_ws_user_seat(fn, owner, ws, acting): locks the workspace row
--    (FOR UPDATE, as every change on the workspace screen) and says what the
--    acting login is there: an Admin user with the users area
--    (mantle_scope_has_area: the scope's own login and Admin in the scope;
--    never the bare mantle_area_rule) or a Moderator. A workspace the
--    acting login may not see is not_found, as the screen answers. Private.
-- 4. mantle_ws_add_user(owner, ws, login, moderator),
--    mantle_ws_set_moderator(owner, ws, login, moderator, by),
--    mantle_ws_remove_user(owner, ws, login): the rules of
--    server/web/lib/workspaces.ts addUser, setModerator and removeUser,
--    moved, in the order the routes answered in: a Moderator of the
--    workspace or an Admin user with the users area manages its users; the
--    Moderator tick, any Admin workspace change and removing a Moderator
--    need the users area; Admin users stay Moderators of Admin; never the
--    last Moderator; an archived workspace, a login already a user and a
--    self-removal from Admin are refused; the anchor stays in Admin. Each
--    writes its workspace_events row. SECURITY DEFINER, PUBLIC revoked, the
--    write role's (WRITE_ROLE_FUNCTIONS, granted at boot; the runtime role
--    runs what a viewer role runs).
-- 5. mantle_ws_create (0293): the same "no acting login: refused unless
--    system work" (it skipped every check when unscoped), and a login
--    other than the acting one is refused whether a scope is open or only
--    its login is set.
-- 6. mantle_ws_private_workspace (0272): only for the acting login
--    (`login` = mantle_scope_login_id()), or system work. createHomeFallback
--    (packages/db client.ts) carried no write scope (a plain system-pool
--    read): it now sets mantle.scope_login in a transaction of its own.
-- 7. mantle_workspace_event (0279): with no acting login refused unless
--    system work.
--
-- A refusal a route answers says `mantle_ws:<code>` first, with its
-- SQLSTATE: 42501 (a right), P0002 (nothing there), 55000 (a state the
-- change may not make). server/web/lib/workspaces.ts maps the pair to
-- today's WsError by one table (wsRefusal).
--
-- No table, row or trigger changes. Re-runnable: CREATE OR REPLACE only.
-- The number is claimed at the merge (plan v3.2 rule 3): written as 0305,
-- `when` 1790197620000 (above 0304's 1790197560000).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_system_work"()
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_scope_login_id"() IS NULL
     AND NOT "public"."mantle_scope_active"()
     AND coalesce(current_setting('mantle.write_mode', true), '') <> 'ro'
     AND coalesce(current_setting('mantle.actor', true), '') = ANY (ARRAY[
           'system:ws-clear-ticks'
         ]::text[])
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_system_work"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_acting_login"(fn text, owner uuid)
  RETURNS uuid LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
DECLARE
  acting uuid := "public"."mantle_scope_login_id"();
BEGIN
  IF owner IS DISTINCT FROM "public"."mantle_brain_id"() THEN
    RAISE EXCEPTION 'mantle_ws:not_brain %: only on this brain', fn USING ERRCODE = '42501';
  END IF;
  -- A read-only caller (a read key, a peer with Write off) changes nothing.
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RAISE EXCEPTION 'mantle_ws:read_only %: a read-only caller', fn USING ERRCODE = '42501';
  END IF;
  IF acting IS NULL THEN
    IF "public"."mantle_ws_system_work"() THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'mantle_ws:no_acting_login %: no acting login, and not system work', fn
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "auth"."users" l WHERE l."id" = acting AND l."disabled_at" IS NULL) THEN
    RAISE EXCEPTION 'mantle_ws:no_acting_login %: the acting login is not an enabled login', fn
      USING ERRCODE = '42501';
  END IF;
  RETURN acting;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_acting_login"(text, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_user_seat"(
  fn text, owner uuid, ws uuid, acting uuid,
  OUT is_admin boolean, OUT archived boolean, OUT admin_users boolean, OUT moderator boolean)
  LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  member boolean := false;
BEGIN
  SELECT w."is_admin", w."archived_at" IS NOT NULL INTO is_admin, archived
    FROM "public"."workspaces" w
   WHERE w."id" = ws AND w."owner_id" = owner
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mantle_ws:not_found %: no such workspace', fn USING ERRCODE = 'P0002';
  END IF;
  admin_users := false;
  moderator := false;
  -- System work (no acting login): nobody to ask; the invariants still hold.
  IF acting IS NULL THEN RETURN; END IF;
  admin_users := "public"."mantle_scope_has_area"('users');
  SELECT true, u."moderator" INTO member, moderator
    FROM "public"."workspace_users" u
   WHERE u."workspace_id" = ws AND u."login_id" = acting;
  member := coalesce(member, false);
  moderator := coalesce(moderator, false);
  -- The workspace if the acting login may see it: a user of it, or an Admin
  -- user with the users area (an archived one only the latter).
  IF NOT admin_users AND (NOT member OR archived) THEN
    RAISE EXCEPTION 'mantle_ws:not_found %: no such workspace', fn USING ERRCODE = 'P0002';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_user_seat"(text, uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Add `login` to `ws`, with the Moderator tick when `moderator`.
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
REVOKE ALL ON FUNCTION "public"."mantle_ws_add_user"(uuid, uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
-- Tick or clear `login`'s Moderator tick on `ws`; `by` names a command on
-- its event row (system work), else NULL.
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
  IF s.is_admin AND NOT tick THEN
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
-- Remove `login` from `ws` (the acting login itself: it leaves).
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
REVOKE ALL ON FUNCTION "public"."mantle_ws_remove_user"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- 0293's mantle_ws_create with the acting login's check first.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_create"(
  owner uuid, login uuid, ws_name text, ws_description text)
  RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  wid uuid;
  acting uuid := "public"."mantle_scope_login_id"();
BEGIN
  IF acting IS NULL AND NOT "public"."mantle_ws_system_work"() THEN
    RAISE EXCEPTION 'mantle_ws_create: no acting login, and not system work'
      USING ERRCODE = '42501';
  END IF;
  IF (acting IS NOT NULL OR "public"."mantle_scope_active"()) AND NOT (
       login IS NOT DISTINCT FROM acting
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
-- 0272's mantle_ws_private_workspace, only for the acting login (or system
-- work): nothing makes one behind a login's back.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_private_workspace"(login uuid)
  RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  ws uuid;
  label text;
BEGIN
  IF login IS DISTINCT FROM "public"."mantle_scope_login_id"()
     AND NOT "public"."mantle_ws_system_work"() THEN
    RAISE EXCEPTION 'mantle_ws_private_workspace: only the acting login''s own'
      USING ERRCODE = '42501';
  END IF;
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
-- 0279's mantle_workspace_event, refused with no acting login unless
-- system work.
CREATE OR REPLACE FUNCTION "public"."mantle_workspace_event"(
  ws uuid, actor uuid, action text, subject jsonb)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  node uuid;
BEGIN
  IF "public"."mantle_scope_login_id"() IS NULL AND NOT "public"."mantle_ws_system_work"() THEN
    RAISE EXCEPTION 'mantle_workspace_event: no acting login, and not system work'
      USING ERRCODE = '42501';
  END IF;
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
