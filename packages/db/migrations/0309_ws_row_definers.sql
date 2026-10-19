-- The workspace row in SQL (workspaces arch plan v3.2, S2b): what a
-- workspace is called and how it looks, its contact, its landing app and
-- its archive are decided in the database, by the acting login, never by
-- the pool a write runs on. After this no TypeScript writes the workspace
-- tables (the system exit 'workspace-write' is gone).
--
-- b1:
-- 1. mantle_ws_update_about(owner, ws, patch): the name, description,
--    colour and icon (server/web/lib/workspaces.ts patchWorkspace's rules,
--    moved, in the order the route answered in): the workspace as the
--    acting login may see it (mantle_ws_user_seat, 0307, which locks the
--    row); archived refused; a Moderator of it or an Admin user with the
--    users area; Admin keeps its name; the name Admin is reserved. `patch`
--    is a jsonb object whose keys are the fields to set (a key with JSON
--    null clears the colour or the icon; a key not there is left as it is).
--    Writes the row and one workspace.update event with the fields that
--    changed, or nothing when none did.
-- 2. mantle_ws_set_contact(owner, ws, contact): the contact. An Admin user
--    with the users area; a contact node of the brain, or NULL to clear;
--    archived refused. Its own workspace.update event ({contactNodeId}).
--
-- b2:
-- 3. mantle_ws_app_held(owner, ws, app): THE rule "workspace `ws` holds
--    app `app` and its published build is green" (@mantle/content
--    workspaceHeldApp's SQL, moved: an app node of the brain that `ws`
--    reads by its own grant, never the reader's other workspaces). Private.
-- 4. mantle_ws_set_landing(owner, ws, app): the landing app. A Moderator of
--    the workspace (never an Admin area: the landing page is the
--    workspace's own setting); an app it holds with a green build (3), or
--    NULL for the Built-in home; archived refused. A workspace.landing
--    event ({appId}) when it changes.
--    The assistant on PATCH is 0307's mantle_ws_set_assistant (the
--    TypeScript copy is gone).
--
-- b3:
-- 5. mantle_ws_archive(owner, ws): the archive. The heads of every item the
--    workspace holds but is not the home of come first (mantle_lock_heads,
--    the order withHeads takes: by node id), then the workspace row
--    (mantle_ws_user_seat). A Moderator of it or an Admin user with the
--    users area; never Admin; archived refused; refused while it is any
--    item's home. Rows found after the first lock are locked NOWAIT
--    (mantle_lock_heads_more): a busy one fails with 55P03 and the caller
--    retries the whole transaction (withDeadlockRetry stays in TypeScript).
--    Drops the workspace's shares and "removed here" exclusions, stamps
--    archived_at, writes the workspace.archive event, and returns the
--    counts the route answers. It runs on the system pool in the login's
--    write scope (withSystemPoolInWriteScope): the heads of items the
--    acting login does not read are locked too (mantle_heads_scope_filter
--    drops those for the write role), as on the system pool before. The
--    runtime role's (RUNTIME_SYSTEM_FUNCTIONS), no viewer or write role.
--
-- Every definer: SECURITY DEFINER, search_path public, pg_temp, PUBLIC
-- revoked; the acting login is mantle_scope_login_id() (mantle_ws_acting_login,
-- 0307), an enabled login on its brain, never read-only; with no acting
-- login refused (mantle_ws_system_work names none of them). 1, 2 and 4 are
-- the write role's (WRITE_ROLE_FUNCTIONS, granted at boot).
--
-- A refusal a route answers says `mantle_ws:<code>` first, with its
-- SQLSTATE: 42501 (a right), P0002 (nothing there), 55000 (a state the
-- change may not make), 22023 (a value). server/web/lib/workspaces.ts maps
-- the pair to today's WsError by one table (wsRefusal).
--
-- No table, row or trigger changes; no function before this one changes.
-- Re-runnable: CREATE OR REPLACE only. The number is claimed at the merge
-- (plan v3.2 rule 3): written as 0309, `when` 1790197860000 (above S6 c1's
-- 0308, 1790197800000).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- 1. The name, description and look.
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
REVOKE ALL ON FUNCTION "public"."mantle_ws_update_about"(uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
-- 2. The contact: a contact node of the brain, or NULL.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_set_contact"(owner uuid, ws uuid, contact uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  fn constant text := 'mantle_ws_set_contact';
  acting uuid := "public"."mantle_ws_acting_login"(fn, owner);
  s record;
  cur uuid;
BEGIN
  SELECT * INTO s FROM "public"."mantle_ws_user_seat"(fn, owner, ws, acting);
  IF s.archived THEN
    RAISE EXCEPTION 'mantle_ws:archived %: the workspace is archived', fn USING ERRCODE = '55000';
  END IF;
  IF NOT s.admin_users THEN
    RAISE EXCEPTION 'mantle_ws:contact_admin_only %: the contact needs the users area', fn
      USING ERRCODE = '42501';
  END IF;
  IF contact IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "public"."nodes" n
        WHERE n."id" = contact AND n."owner_id" = owner AND n."type" = 'contact') THEN
    RAISE EXCEPTION 'mantle_ws:no_contact %: no such contact', fn USING ERRCODE = '22023';
  END IF;
  SELECT w."contact_id" INTO cur FROM "public"."workspaces" w WHERE w."id" = ws;
  IF cur IS NOT DISTINCT FROM contact THEN RETURN; END IF;
  UPDATE "public"."workspaces" w SET "contact_id" = contact, "updated_at" = now()
   WHERE w."id" = ws;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, 'workspace.update', jsonb_build_object('contactNodeId', contact));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_set_contact"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- 3. Workspace `ws` holds app `app` (its own grant), and whether the app's
-- published build is green. No row: it does not hold it. Private.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_app_held"(owner uuid, ws uuid, app uuid)
  RETURNS TABLE ("app_id" uuid, "title" text, "ready" boolean)
  LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT n."id", n."title", (a."published_build" ->> 'ok')::boolean IS TRUE
    FROM "public"."nodes" n
    JOIN "public"."apps" a ON a."node_id" = n."id"
   WHERE n."id" = app AND n."owner_id" = owner AND n."type" = 'app'
     AND ws = ANY (n."read_ws")
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_app_held"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- 4. The landing app: an app the workspace holds with a green build, or
-- NULL (the Built-in home).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_set_landing"(owner uuid, ws uuid, app uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  fn constant text := 'mantle_ws_set_landing';
  acting uuid := "public"."mantle_ws_acting_login"(fn, owner);
  s record;
  held record;
  cur uuid;
BEGIN
  SELECT * INTO s FROM "public"."mantle_ws_user_seat"(fn, owner, ws, acting);
  IF s.archived THEN
    RAISE EXCEPTION 'mantle_ws:archived %: the workspace is archived', fn USING ERRCODE = '55000';
  END IF;
  IF NOT s.moderator THEN
    RAISE EXCEPTION 'mantle_ws:landing_forbidden %: only a Moderator sets the landing page', fn
      USING ERRCODE = '42501';
  END IF;
  IF app IS NOT NULL THEN
    SELECT * INTO held FROM "public"."mantle_ws_app_held"(owner, ws, app);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mantle_ws:landing_app_not_held %: the workspace does not hold the app', fn
        USING ERRCODE = '55000';
    END IF;
    IF NOT held."ready" THEN
      RAISE EXCEPTION 'mantle_ws:landing_app_not_ready %: the app has no green published build', fn
        USING ERRCODE = '55000';
    END IF;
  END IF;
  SELECT w."landing_app_id" INTO cur FROM "public"."workspaces" w WHERE w."id" = ws;
  IF cur IS NOT DISTINCT FROM app THEN RETURN; END IF;
  UPDATE "public"."workspaces" w SET "landing_app_id" = app, "updated_at" = now()
   WHERE w."id" = ws;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, acting, 'workspace.landing', jsonb_build_object('appId', app));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_set_landing"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- 5. The archive. Returns {items, grants}: what the route answers.
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
  SELECT k."items", k."grants", k."exclusions" INTO c
    FROM "public"."mantle_ws_item_counts"(ws) k;
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
