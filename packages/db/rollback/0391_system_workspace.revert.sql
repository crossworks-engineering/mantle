-- Rollback of 0391_system_workspace: what an operator runs BEFORE pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- It takes the System workspace out (its users and its rows go with it; its
-- events stay, their workspace set to NULL), puts back the bodies the image
-- before it shipped (mantle_ws_system_work 0321 as 0322 left it, mantle_area_rule,
-- mantle_ws_add_user and mantle_ws_remove_user 0330, mantle_ws_set_moderator
-- 0307, mantle_ws_archive and mantle_ws_update_about 0309,
-- mantle_ws_last_admin_mod_trg 0241, mantle_ws_migrate 0286), drops the two
-- functions it added (mantle_ws_system_id, mantle_ws_ensure_system), puts
-- the name index back to "Admin" only (workspaces_reserved_name_uq, 0286), and
-- takes it off the ledger, so the next roll forward applies it again. Every
-- Admin user then holds every area again, as before.
--
-- It refuses (nothing changes) while any item holds a grant to System: a
-- grant row keeps its workspace (item_grants, ON DELETE RESTRICT). Move or
-- unshare those items first. Any other row that names System (an assistant
-- placed there) stops it the same way.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0391_system_workspace.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $$
DECLARE
  held integer;
BEGIN
  SELECT count(*)::int INTO held
    FROM "public"."item_grants" g
    JOIN "public"."workspaces" w ON w."id" = g."workspace_id" AND w."bridge_key" = 'system';
  IF held > 0 THEN
    RAISE EXCEPTION 'System holds % grant(s); nothing reverted', held
      USING ERRCODE = '55000',
            HINT = 'Move or unshare the items granted to the System workspace first (select node_id from item_grants g join workspaces w on w.id = g.workspace_id and w.bridge_key = ''system''), then run this again.';
  END IF;
  DELETE FROM "public"."workspaces" w WHERE w."bridge_key" = 'system';
END
$$;
--> statement-breakpoint
-- The name index as 0286 made it: "Admin" only.
DROP INDEX IF EXISTS "public"."workspaces_reserved_name_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_reserved_name_uq"
  ON "public"."workspaces" ("owner_id", lower(btrim("name")))
  WHERE "archived_at" IS NULL AND lower(btrim("name")) = 'admin';
--> statement-breakpoint
-- mantle_ws_system_work: 0321's body, its actor read as 0322 rewrote it.
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
           ('system:snapshot-copies', 'mantle_file_restamp_home'))
$$;
--> statement-breakpoint
-- mantle_area_rule: 0330's body.
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
-- mantle_ws_add_user: 0330's body.
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
-- mantle_ws_remove_user: 0330's body.
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
-- mantle_ws_set_moderator: 0307's body.
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
-- mantle_ws_archive: 0309's body.
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
  IF s.is_admin THEN
    RAISE EXCEPTION 'mantle_ws:archive_admin %: the Admin workspace is never archived', fn
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
-- mantle_ws_update_about: 0309's body.
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
    -- and a later clash would tell them it exists.
    IF s.is_admin THEN
      RAISE EXCEPTION 'mantle_ws:admin_keeps_name %: the Admin workspace keeps its name', fn
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
-- mantle_ws_last_admin_mod_trg: 0241's body.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_last_admin_mod_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  ws uuid := OLD."workspace_id";
  is_admin_ws boolean;
BEGIN
  SELECT w."is_admin" INTO is_admin_ws FROM "public"."workspaces" w WHERE w."id" = ws;
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
    RAISE EXCEPTION 'the Admin workspace needs at least one Moderator' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- mantle_ws_migrate: 0286's body.
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
DROP FUNCTION IF EXISTS "public"."mantle_ws_ensure_system"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_ws_system_id"(uuid);
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792300000000;
