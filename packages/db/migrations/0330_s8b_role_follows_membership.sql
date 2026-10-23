-- Membership decides; auth.users.role follows it exactly (workspaces arch
-- plan v3.2, S8b; section 2.2 point 4). No writer trigger: the membership
-- definers write the column.
--
-- 1. mantle_ws_add_user and mantle_ws_remove_user (0307) on the Admin
--    workspace set auth.users.role to 'admin' or 'member' in the same
--    transaction as the workspace_users row. Their bodies are 0307's, byte
--    for byte, with that one UPDATE after the row is written. So the role
--    equals Admin membership by construction, and an image one release
--    back (which still reads the role) reads an exact column.
-- 1a. With no scope (the Users screen's role change and admin login
--    create, an Admin area exit at the full-route spot login-credential)
--    the two take the exit's acting login, only from a system session that
--    is not the narrow login and only on the Admin workspace
--    (mantle_ws_exit_login, 0315's rule), and ask the area rule of that
--    login for the users area. In a scope nothing changes.
-- 2. mantle_login_is_admin_user(login) = mantle_login_is_admin(login):
--    membership only (a user of the brain's live Admin workspace, the login
--    enabled; 0304). Before: role admin AND that (0306). With the role
--    written by the definers the two agree; on a box with role drift 0 (the
--    precondition) no answer changes.
-- 3. mantle_bridge_login(login): demote only. Nothing in this image calls
--    it; an image one release back still does (login create, the role
--    change, an invite) right after writing the role, and must not fail.
--    Its demotion writes role member and calls the bridge, which takes the
--    login out of Admin (the row, and a 'bridge.login' event, as 0286's
--    bridge wrote them); it never adds a row, never takes the anchor out,
--    and reads the login's own role only (no former-client override). So that image's promotion or
--    admin login create lands as drift the other way (role admin, no Admin
--    row): not Admin to every membership reader, and not to that image
--    either (0306's pair asks both), so narrow. Where the role guard below
--    stands, that image's role write is refused outright unless its pool
--    is the superuser. A rollback still runs the revert first: it is
--    mandatory (the guard refuses the older image's role writes, and only
--    the revert puts back the bridge that adds).
-- 3a. mantle_ws_migrate_bridged (the workspaces switch's first part, 0286;
--    its flag signed by 0327): its live body byte for byte, but the Admin rows the bridge wrote (a row,
--    Moderator, and a 'bridge.login' event per admin login) are written by
--    the switch itself. Before the switch the role is the only record of
--    who is an admin, so the switch reads it once; a brain switched after
--    0330 ends as one switched before.
-- 4. The login and connector bridges' triggers go where a brain still has
--    them (only one that never took the workspaces switch; 0261 dropped
--    them everywhere else): users_zz_bridge, tool_groups_zz_bridge, their
--    trigger functions and mantle_bridge_connector.
-- 5. mantle_login_role(login): the display role. 'admin' when the login has
--    a user row in the brain's live Admin workspace, enabled or not (a
--    disabled login shows its own flag); else 'member' (former clients are
--    members since 0272). Decides nothing; decisions keep
--    mantle_login_is_admin's enabled check. A read definer.
-- 6. mantle_scope_admin_facts(asked): adminFacts' one round trip in the
--    login's own scope (server/web lib/auth/login.ts). admin = the scope
--    holds the brain's live Admin workspace AND the scope's login
--    (mantle_scope_login_id, the reader) is an enabled user of that very
--    workspace now; held = those of `asked` mantle_scope_has_area holds,
--    only when admin. Before S8b adminFacts ANDed the login row's legacy
--    pair (role admin AND a user of Admin) in TypeScript because
--    mantle_scope_is_admin trusts only mantle.ws (S8c fix round 1); this
--    asks the owner and membership in SQL instead. mantle_view_user's, as
--    mantle_scope_is_admin.
--
-- 7. mantle_admin_seat(login): the one base read of an Admin seat, a row
--    when the login is a user of the brain's live Admin workspace (that
--    workspace, whether the login is enabled, its limits). Granted to no
--    app role. mantle_login_is_admin (0304's answer: a seat, enabled),
--    mantle_area_rule (0304's: a seat, enabled, the area not turned off),
--    mantle_login_role (a seat), mantle_scope_admin_facts (a seat, enabled,
--    its workspace in the scope) and the drift report wrap it, so "who is
--    an Admin user" is written once. 0304's two bodies give the same
--    answer for every login.
-- 8. The role guard (users_role_guard, BEFORE INSERT OR UPDATE OF role on
--    auth.users): the role column changes only when the current user is
--    the membership definers' owner (the migrator, who runs them), or a
--    superuser. An insert by any other role names role member, except the
--    first owner row (is_owner, role admin, the table empty: the first-run
--    signup; with an owner there, the single-owner index answers). So no app role writes the column but through the definers,
--    whatever its table grants. A guard, not a writer: it changes no row.
-- 9. The precondition at migrate time (the DO block at the end): any login
--    with an Admin seat but not role admin (a disabled one and a former
--    client too) refuses the migrate; the other drift is a NOTICE.
-- 10. mantle_role_drift() (0304) counts former clients too: 0304 left them
--    out because 0286's bridge read a former client as no role; since 0272
--    a former client is a member like any other login (its role says so),
--    and the bridge reads the login's own role (3 above). Still the enabled
--    logins only (a decision reads an enabled login; the all-logins count
--    beside it in the NOTICE covers the disabled ones).
--
-- Identity is read only through the readers (mantle_scope_login_id,
-- mantle_scope_ws), never current_setting directly.
--
-- Numbered 0330 on the rebase onto main v0.300.137 (b2 and b3 took 0315 to
-- 0329); its journal `when` sits above 0329's.
--
-- Revert: packages/db/rollback/0330_s8b_role_follows_membership.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_login"(login uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  admin_ws uuid;
  r text;
  gone int;
BEGIN
  -- Demote only since S8b: the membership definers add (0286's lookup and
  -- its removal half; its add half is gone).
  -- The anchor stays in Admin, as the Admin removal definer keeps it
  -- (0272's CHECK makes its role admin anyway; this does not lean on that).
  IF login IS NOT DISTINCT FROM "public"."mantle_brain_id"() THEN RETURN; END IF;
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin';
  IF admin_ws IS NULL THEN RETURN; END IF;
  -- The login's own role decides, nothing else: 0286 read a former client
  -- (archive_client_logins) as no role, which a row there could use to take
  -- an Admin user out of Admin. Former clients are members since 0272, so
  -- their role says the same without it.
  SELECT u."role" INTO r FROM auth.users u WHERE u."id" = login;
  -- A login that is not role admin is not a user of Admin.
  DELETE FROM "public"."workspace_users" u
   WHERE u."login_id" = login AND u."workspace_id" = admin_ws AND coalesce(r, '') <> 'admin';
  GET DIAGNOSTICS gone = ROW_COUNT;
  IF gone > 0 THEN
    INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
    VALUES (admin_ws, NULL, 'bridge.login', jsonb_build_object('login', login, 'role', r));
  END IF;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_login"(uuid) FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_zz_bridge" ON "auth"."users";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "tool_groups_zz_bridge" ON "public"."tool_groups";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_bridge_login_trg"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_bridge_connector_trg"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_bridge_connector"(uuid, text);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_is_admin_user"(login uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_login_is_admin"(login)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_login_is_admin_user"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- The Admin seat, the one base read the five below wrap. Not a definer and
-- no SET (every name in it qualified), so the planner inlines it into each
-- definer that reads it, which runs it as the definer's owner: the wrap
-- then costs what 0304's own bodies did (S8b round 5 measured the
-- not-inlined seat at 1.3 to 1.7 times per call). No app role may run it.
CREATE OR REPLACE FUNCTION "public"."mantle_admin_seat"(login uuid)
  RETURNS TABLE (ws uuid, enabled boolean, limits jsonb)
  LANGUAGE sql STABLE AS $$
  SELECT w."id", l."disabled_at" IS NULL, u."limits"
    FROM "public"."workspaces" w
      JOIN "public"."workspace_users" u ON u."workspace_id" = w."id" AND u."login_id" = login
      JOIN "auth"."users" l ON l."id" = u."login_id"
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin"
     AND w."archived_at" IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_admin_seat"(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_is_admin"(login uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."mantle_admin_seat"(login) s WHERE s."enabled")
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_area_rule"(login uuid, area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."mantle_admin_seat"(login) s
     WHERE s."enabled"
       AND area IN ('settings', 'users', 'assistants', 'connectors', 'keys')
       AND coalesce(s."limits" -> 'areas' ->> area, '') <> 'false')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_role"(login uuid)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM "public"."mantle_admin_seat"(login))
              THEN 'admin' ELSE 'member' END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_login_role"(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_admin_facts"(asked text[],
  OUT admin boolean, OUT held text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH a AS (
    SELECT EXISTS (
      SELECT 1 FROM "public"."mantle_admin_seat"("public"."mantle_scope_login_id"()) s
       WHERE s."enabled" AND s."ws" = ANY ("public"."mantle_scope_ws"())) AS admin)
  SELECT a.admin,
         CASE WHEN a.admin THEN
           coalesce((SELECT array_agg(t.x ORDER BY t.o)
                       FROM unnest(asked) WITH ORDINALITY AS t(x, o)
                      WHERE "public"."mantle_scope_has_area"(t.x)), '{}'::text[])
         ELSE '{}'::text[] END
    FROM a
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_scope_admin_facts"(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_scope_admin_facts"(text[]) TO mantle_view_user;
--> statement-breakpoint
-- With no scope, the Users screen's role change and admin login create
-- (an Admin area exit at the full-route spot login-credential, on the
-- system pool) add to or remove from Admin in the caller's name: the exit's
-- acting login, which only the gateway's own SET names (0315's rule for a
-- definer that acts for a login with no scope). Only from a system session
-- that is not the narrow login (the write role and every other login are
-- no system session; the narrow role may not run the two definers
-- either), only on the brain's Admin workspace, and only for an enabled
-- login; the definer then asks the area rule of that login (an Admin user
-- with the users area, mantle_area_rule) where a scope would ask the
-- scope's. NULL anywhere else (a scope login or an open scope: the
-- definer takes the scope's login, as 0307).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_exit_login"(fn text, owner uuid, ws uuid)
  RETURNS uuid LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
DECLARE
  acting uuid := "public"."mantle_identity_acting_login"();
BEGIN
  IF acting IS NULL
     OR "public"."mantle_scope_login_id"() IS NOT NULL
     OR "public"."mantle_scope_active"()
     OR NOT "public"."mantle_system_session"()
     OR session_user = 'mantle_system_narrow'
     -- A system session that took another role (the write role, a viewer
     -- role) is that role now: mantle_ws_system_work's own test. (Worded
     -- so: the definers' DDL scan reads this body, comments too.)
     OR (CASE WHEN current_setting('role') = 'none' THEN session_user::text
              ELSE current_setting('role') END) NOT IN (
          SELECT x FROM unnest(ARRAY['mantle_system', 'mantle_runtime', 'mantle_owner',
                                     current_user::text]) x
          UNION ALL
          SELECT r."rolname"::text FROM pg_catalog.pg_roles r WHERE r."rolsuper")
     OR (CASE WHEN current_setting('role') = 'none' THEN session_user::text
              ELSE current_setting('role') END) = 'mantle_system_narrow'
     OR owner IS DISTINCT FROM "public"."mantle_brain_id"()
     OR NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                     WHERE w."id" = ws AND w."owner_id" = owner AND w."is_admin") THEN
    RETURN NULL;
  END IF;
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RAISE EXCEPTION 'mantle_ws:read_only %: a read-only caller', fn USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "auth"."users" l
                  WHERE l."id" = acting AND l."disabled_at" IS NULL) THEN
    RAISE EXCEPTION 'mantle_ws:no_acting_login %: the acting login is not an enabled login', fn
      USING ERRCODE = '42501';
  END IF;
  RETURN acting;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_exit_login"(text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
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
  END IF;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, CASE WHEN self THEN 'user.leave' ELSE 'user.remove' END,
          jsonb_build_object('login', login));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_remove_user"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- The switch's first part (its live body: 0286's with the derivation flag
-- signed as 0327 rewrote it; only its users step changes): it wrote
-- Admin's rows through the bridge, which only demotes now.
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
  -- (S8b: the bridge only demotes now, so its Admin step is written here: on
  -- the Admin workspace just made, a row and an event per admin login, as
  -- the bridge wrote them. Before the switch the role is the only record
  -- of who is an admin; from here membership decides and the definers keep
  -- the role in step.)
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
  SELECT admin_ws, u."id", true FROM auth.users u
   WHERE u."role" = 'admin'
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" a WHERE a."login_id" = u."id");
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  SELECT admin_ws, NULL, 'bridge.login', jsonb_build_object('login', u."id", 'role', 'admin')
    FROM auth.users u
   WHERE u."role" = 'admin'
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" a WHERE a."login_id" = u."id");
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
  PERFORM "public"."mantle_acl_on"();
  UPDATE "public"."facts" f SET "read_ws" = ARRAY[admin_ws]
   WHERE f."source_node_id" IS NULL AND f."owner_id" = brain AND f."read_ws" = '{}'::uuid[];
  PERFORM "public"."mantle_acl_restore"('');

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
-- The role guard (point 8). Not SECURITY DEFINER: it asks who runs the
-- write (current_user), which a definer's own body sets to its owner.
CREATE OR REPLACE FUNCTION "public"."mantle_login_role_guard"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
BEGIN
  -- This function's own owner: the migrator, who made it in the migration
  -- that made the membership definers, and so their owner too (migrate
  -- reassigns no function). Named by itself, so the guard reaches no
  -- function a role writing auth.users would need EXECUTE on.
  IF current_user = (SELECT p."proowner"::regrole::name FROM pg_catalog.pg_proc p
                      WHERE p."oid" = '"public"."mantle_login_role_guard"()'::regprocedure)
     OR coalesce((SELECT r."rolsuper" FROM pg_catalog.pg_roles r WHERE r."rolname" = current_user), false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."role" IS DISTINCT FROM OLD."role" THEN
      RAISE EXCEPTION 'mantle_role:membership_only: the role follows Admin membership; add to or remove from Admin instead'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- The first owner: the table empty. With an owner there already the
  -- single-owner index (0111) refuses the row (or ON CONFLICT DO NOTHING
  -- skips it), so it is let through to that answer; an owner row lands only
  -- on an empty table either way.
  IF NEW."role" = 'member'
     OR (NEW."role" = 'admin' AND NEW."is_owner"
         AND (NOT EXISTS (SELECT 1 FROM "auth"."users")
              OR EXISTS (SELECT 1 FROM "auth"."users" o WHERE o."is_owner"))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'mantle_role:membership_only: a new login is a member; add it to Admin instead'
    USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_login_role_guard"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_role_guard" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "users_role_guard" BEFORE INSERT OR UPDATE OF "role" ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_login_role_guard"();
--> statement-breakpoint
-- 0304's count without its former-client clause (10 in the header).
CREATE OR REPLACE FUNCTION "public"."mantle_role_drift"()
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT count(*)::int
    FROM "auth"."users" l
   WHERE l."disabled_at" IS NULL
     AND coalesce(l."role" = 'admin', false) <> "public"."mantle_login_is_admin"(l."id")
$$;
--> statement-breakpoint
-- The precondition, read at migrate time (numbers only):
-- role drift (mantle_role_drift: enabled logins whose role disagrees with
-- Admin membership; and the same over every login, disabled ones and
-- former clients too, whose role the display reads) and brains without a live Admin
-- workspace. Each must be 0 on a box before this image rolls there:
-- scripts/arch-scoreboard-box.sh prints all three before the roll
-- (role_drift, role_drift_all_logins, brains_without_admin_workspace, and
-- s8b_precondition_met). The NOTICE is the after-the-fact record: migrate
-- (packages/db/src/migrate.ts) sets no onnotice, so postgres.js prints it
-- to the migrate output (its container's log: `docker logs mantle_migrate
-- 2>&1 | grep 'mantle S8b'`; scripts/roll.sh prints that log on a failed roll).
--
-- One direction of drift refuses the migrate (42501, this file rolls back
-- whole): a login with an Admin seat but a role other than admin, whether
-- enabled or not and whether a former client or not. Before 0330 such a
-- login was no Admin user (0306 asked the role AND the seat); from here
-- the seat alone decides, so it would become one (a disabled one on its
-- re-enable, which writes no role): a looser answer. Repair before the
-- roll, on the image one release back: take it out of Admin (the Admin
-- workspace's users, or mantle_ws_remove_user); only a login that should
-- be an Admin user gets role admin instead (the Users screen's promotion),
-- which makes it one. Then migrate again. The other direction (role
-- admin, no seat) is narrower under 0330 and stays a NOTICE. The same
-- count, as plain SQL on the schema before 0330, is the roll's preflight
-- (scripts/roll.sh 2e, the updater's s8b_seat_refusal), so a roll that
-- would end here is refused before it starts.
--
-- The order: a brain still off workspaces has no Admin workspace, so no
-- seat and nothing to refuse here; its switch runs after migrate (the boot
-- step, server/main.ts) through mantle_ws_migrate_bridged above, which
-- seats exactly the role admin logins, so it ends with no drift either
-- way. A switched brain wrote its seats long before (0252 or a boot).
DO $$
DECLARE
  drift int := "public"."mantle_role_drift"();
  drift_all int;
  no_admin int;
  looser int;
BEGIN
  SELECT count(*)::int INTO drift_all
    FROM "auth"."users" l
   WHERE coalesce(l."role" = 'admin', false) <> ("public"."mantle_login_role"(l."id") = 'admin');
  SELECT count(*)::int INTO no_admin
    FROM "auth"."users" o
   WHERE o."is_owner"
     AND NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                      WHERE w."owner_id" = o."id" AND w."is_admin" AND w."archived_at" IS NULL);
  SELECT count(*)::int INTO looser
    FROM "auth"."users" l
   WHERE NOT coalesce(l."role" = 'admin', false)
     AND "public"."mantle_login_role"(l."id") = 'admin';
  RAISE NOTICE 'mantle S8b: role drift % (enabled logins), % (all logins); brains without a live Admin workspace %',
    drift, drift_all, no_admin;
  IF looser > 0 THEN
    RAISE EXCEPTION 'mantle S8b: % login(s) hold an Admin seat without role admin (disabled ones and former clients counted); membership alone would make them Admin users', looser
      USING ERRCODE = '42501',
            HINT = 'On the image one release back, take each out of Admin first (the Admin workspace''s users, or mantle_ws_remove_user), then migrate again. Only a login that should be an Admin user gets role admin instead (the Users screen''s promotion): that makes it an Admin user. The logins: select l.id from auth.users l join workspace_users u on u.login_id = l.id join workspaces w on w.id = u.workspace_id and w.owner_id = mantle_brain_id() and w.is_admin and w.archived_at is null where l.role <> ''admin''.';
  END IF;
END
$$;
