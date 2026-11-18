-- Shared items in a workspace (owner's rule, dev-brain page "Permissions",
-- 2026-11-18). An item granted to a workspace W (not its home) is held by W.
-- Its rights for a login in W:
--  - a Moderator of W: read, create and upload in it (items and folders),
--    write, and move it inside W, whether W's grant has Write on or off. No
--    delete, no home move;
--  - a user of W: read; write with Write on. No create, no delete, no move;
--  - a Moderator of its home: everything, as before.
-- Items whose home is W keep their rules.
--
-- One new check: "the login is a Moderator of a workspace that holds the
-- item". For a move, that workspace holds the folder it lands in too.
--  1. mantle_may_edit_in and mantle_may_edit take the item's read_ws and
--     kind: edit is manage (4), a grant with Write on in the scope, or (new)
--     a Moderator of a workspace that holds it, an app excepted (an app's
--     acts stay its managers' and its Write grants'). The old forms are
--     dropped, so no caller keeps the old rule. mantle_check_row, the write
--     check (mantle_write_check_trg: the row's kind), the two canvas data
--     definers, mantle_default_home, the move check's rename and the canvas
--     data read rule pass them.
--  2. mantle_may_add(home, write_ws, read_ws): adding to a folder (a new item
--     or folder in it, an item moved into it). The edit rule, counting only
--     the folder's home's Write switch: a Moderator of a workspace that holds
--     the folder, a manager of it, or a user of its home with Write on. A
--     user who writes the folder through a shared grant no longer adds to
--     it (the owner accepted this). mantle_may_add_to_folder and
--     mantle_may_create_item ask it.
--  3. mantle_mod_holds(a, b): a workspace the scope moderates holds both. The
--     move check (mantle_nodes_acl_path_trg) and mantle_subtree_rewrite take
--     a move from a manager of the item, as before, or one inside a
--     workspace the caller moderates: mantle_mod_holds(item, folder it lands
--     in). The folder it lands in asks mantle_may_add.
--  4. manage: mantle_may_manage_in(ws, mod_ws, home, read_ws), and its scope
--     forms mantle_may_manage(home, read_ws) and
--     mantle_may_manage_home(home, read_ws), take the item's read_ws. It is
--     a Moderator of the home, or (new, owner's word 2026-11-18, page
--     d7313c67, decision A) an Admin user who reads the item: a Moderator of
--     the brain's Admin workspace (an Admin user's tick there is never
--     cleared) in a scope that reads it (read_ws meets ws, the row rule).
--     "An Admin user counts as a Moderator of the home of any item it can
--     read", and of nothing it does not read. One condition, in the one
--     function every form shares, and edit asks it for its home Moderator
--     (1), so the caps (mayManage, mayMove, the grants panel, linkRights)
--     and the checks answer alike. It feeds every act manage decides:
--     delete, a home move (from its home; the new home still needs a
--     Moderator of it), grants, an app's and a canvas's link, app code,
--     history, an app's exports and timers. The old one-argument forms are
--     dropped; every caller passes the row's read_ws. Where no row is left
--     or made yet (a deleted app's snapshot home, a new item's home), the
--     caller passes ARRAY[home]: the home holds its item, so that read is
--     known, and nothing more is assumed.
-- Delete, grants, links of an app and app code keep manage. A home move
-- keeps mantle_grant_move_home.
--
-- Re-runnable.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- 4. manage: a Moderator of the home, or an Admin user who reads the item
-- (the scope's workspaces meet its read_ws, as the row rule asks). STABLE
-- (was IMMUTABLE): it names the Admin workspace by its definer. The scalar
-- subqueries run once per query, not once per row.
CREATE OR REPLACE FUNCTION "public"."mantle_may_manage_in"(
  ws uuid[], mod_ws uuid[], home uuid, read_ws uuid[])
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT (home IS NOT NULL AND home = ANY (mod_ws))
      OR (coalesce(read_ws && ws, false)
          AND coalesce((SELECT "public"."mantle_ws_admin_id"((SELECT "public"."mantle_brain_id"()))) = ANY (mod_ws), false))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_may_manage"(home uuid, read_ws uuid[])
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT "public"."mantle_may_manage_in"("public"."mantle_scope_ws"(), "public"."mantle_scope_mod_ws"(),
                                         home, read_ws)
$$;
--> statement-breakpoint
-- An item with no home: an Admin scope (0279, unchanged).
CREATE OR REPLACE FUNCTION "public"."mantle_may_manage_home"(home uuid, read_ws uuid[])
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT CASE WHEN home IS NULL THEN "public"."mantle_scope_has_admin"()
              ELSE coalesce("public"."mantle_may_manage"(home, read_ws), false) END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_may_manage_home"(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_may_manage_home"(uuid, uuid[]) TO "mantle_view_user";
--> statement-breakpoint
-- 1. The edit rule, with the workspaces that hold the item: manage (its
-- home Moderators, an Admin user who reads it), a grant with Write on, or
-- a Moderator of a holder (an app excepted). STABLE (was IMMUTABLE): manage is.
CREATE OR REPLACE FUNCTION "public"."mantle_may_edit_in"(
  ws uuid[], mod_ws uuid[], home uuid, write_ws uuid[], read_ws uuid[], kind "public"."node_type")
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT "public"."mantle_may_manage_in"(ws, mod_ws, home, read_ws) OR coalesce(write_ws && ws, false)
         OR (kind IS DISTINCT FROM 'app' AND coalesce(read_ws && mod_ws, false))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_may_edit"(
  home uuid, write_ws uuid[], read_ws uuid[], kind "public"."node_type")
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT "public"."mantle_may_edit_in"("public"."mantle_scope_ws"(), "public"."mantle_scope_mod_ws"(),
                                       home, write_ws, read_ws, kind)
$$;
--> statement-breakpoint
-- 2. Adding to a folder: edit, counting only its home's Write switch.
CREATE OR REPLACE FUNCTION "public"."mantle_may_add"(home uuid, write_ws uuid[], read_ws uuid[])
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce("public"."mantle_may_edit"(
           home,
           CASE WHEN home IS NOT NULL AND home = ANY (write_ws) THEN ARRAY[home] ELSE '{}'::uuid[] END,
           read_ws, 'branch'), false)
$$;
--> statement-breakpoint
-- 3. A workspace the scope moderates holds both a and b.
CREATE OR REPLACE FUNCTION "public"."mantle_mod_holds"(a uuid[], b uuid[])
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM unnest("public"."mantle_scope_mod_ws"()) AS w(id)
                  WHERE w.id = ANY (a) AND w.id = ANY (b))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_check_row"(
  home uuid, write_ws uuid[], read_ws uuid[], need text,
  kind "public"."node_type" DEFAULT NULL, informational boolean DEFAULT false)
  RETURNS boolean LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
BEGIN
  RETURN CASE need
    WHEN 'read' THEN coalesce(read_ws && "public"."mantle_scope_ws"(), false)
    WHEN 'edit' THEN coalesce("public"."mantle_may_edit"(home, write_ws, read_ws, kind), false)
    WHEN 'manage' THEN "public"."mantle_may_manage_home"(home, read_ws)
    WHEN 'admin' THEN "public"."mantle_scope_has_admin"()
    WHEN 'appdata' THEN coalesce("public"."mantle_may_edit"(home, write_ws, read_ws, kind), false)
                        AND (NOT coalesce(informational, false) OR "public"."mantle_scope_has_admin"())
    WHEN 'link' THEN CASE WHEN "public"."mantle_link_needs_manage"(kind)
                          THEN "public"."mantle_may_manage_home"(home, read_ws)
                          ELSE coalesce("public"."mantle_may_edit"(home, write_ws, read_ws, kind), false) END
    WHEN 'link_close' THEN (CASE WHEN "public"."mantle_link_needs_manage"(kind)
                                 THEN "public"."mantle_may_manage_home"(home, read_ws)
                                 ELSE coalesce("public"."mantle_may_edit"(home, write_ws, read_ws, kind), false) END)
                           OR "public"."mantle_scope_has_area"('users')
    ELSE NULL
  END;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_write_check_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  kind text := TG_ARGV[0];
  col text := TG_ARGV[1];
  seen jsonb[] := ARRAY[]::jsonb[];
  r jsonb;
  item uuid;
  n record;
  f record;
  ok boolean;
  ws uuid[];
  generated text[];
  target uuid;
BEGIN
  IF kind = 'self' THEN
    IF TG_OP = 'INSERT' THEN
      IF NOT "public"."mantle_may_add_to_folder"(NEW."owner_id", NEW."type", NEW."path") THEN
        RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
      END IF;
      IF NOT "public"."mantle_may_create_item"(NEW."owner_id", NEW."type", NEW."path")
         AND "public"."mantle_scoped_write_refuses"('INSERT on nodes: no Moderator of the home') THEN
        RAISE EXCEPTION 'not allowed to create an item in that workspace' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW."type" IS DISTINCT FROM OLD."type"
         AND "public"."mantle_scoped_write_refuses"('UPDATE on nodes: a change of kind') THEN
        RAISE EXCEPTION 'not allowed to change the kind of this item' USING ERRCODE = '42501';
      END IF;
      ok := "public"."mantle_check_row"(OLD."home_ws", OLD."write_ws", OLD."read_ws", 'edit', OLD."type");
      IF NOT ok THEN
        -- A change of the presentation keys alone (a board rank): edit of
        -- the item or of its folder. Stored generated columns are not
        -- computed yet in a BEFORE trigger's NEW: left out of the comparison.
        generated := ARRAY(SELECT a."attname"::text FROM pg_attribute a
                            WHERE a."attrelid" = TG_RELID AND a."attgenerated" <> '');
        IF (to_jsonb(NEW) - generated - 'data' - 'updated_at')
             = (to_jsonb(OLD) - generated - 'data' - 'updated_at')
           AND (coalesce(NEW."data", '{}'::jsonb) - "public"."mantle_node_presentation_keys"())
               = (coalesce(OLD."data", '{}'::jsonb) - "public"."mantle_node_presentation_keys"()) THEN
          SELECT p."home_ws", p."write_ws", p."read_ws" INTO f FROM "public"."nodes" p
           WHERE p."id" = "public"."mantle_parent_folder"(OLD."owner_id", OLD."type", OLD."path");
          ok := FOUND AND "public"."mantle_check_row"(f."home_ws", f."write_ws", f."read_ws", 'edit', 'branch');
        END IF;
      END IF;
      IF NOT ok AND "public"."mantle_scoped_write_refuses"('UPDATE on nodes: no edit of the item') THEN
        RAISE EXCEPTION 'not allowed to edit this item' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD."home_ws" IS NULL AND NOT "public"."mantle_may_manage_home"(NULL, OLD."read_ws")
         AND "public"."mantle_scoped_write_refuses"('DELETE on nodes: no home, no Admin scope') THEN
        RAISE EXCEPTION 'not allowed to delete this item' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN seen := seen || to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN seen := seen || to_jsonb(NEW); END IF;
  FOREACH r IN ARRAY seen LOOP
    item := (r ->> col)::uuid;
    IF item IS NULL THEN
      -- A row of no item: inside the scope, and the caller's own.
      IF kind = 'manage' OR NOT (r ? 'read_ws') THEN
        ok := false;
      ELSE
        ws := ARRAY(SELECT jsonb_array_elements_text(r -> 'read_ws'))::uuid[];
        ok := ws <@ "public"."mantle_scope_ws"()
              AND coalesce((r ->> 'login_id')::uuid = "public"."mantle_login_id"(), false);
      END IF;
    ELSE
      SELECT x."home_ws", x."write_ws", x."read_ws", x."type" INTO n FROM "public"."nodes" x WHERE x."id" = item;
      IF NOT FOUND THEN
        ok := true; -- no such item: its foreign key refuses the row
      ELSE
        ok := "public"."mantle_check_row"(n."home_ws", n."write_ws", n."read_ws",
                                          CASE WHEN kind = 'manage' THEN 'manage' ELSE 'edit' END, n."type");
      END IF;
    END IF;
    IF NOT ok AND "public"."mantle_scoped_write_refuses"(
         format('%s on %s: no %s of the item', TG_OP, TG_TABLE_NAME, kind)) THEN
      RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- A new grant, one moved to another workspace, or one made the home: a
  -- Moderator of its workspace. Grant rows only (S11a-7): a `manage` row
  -- with no workspace_id (an export row) is decided by the loop above.
  IF kind = 'manage' AND TG_OP IN ('INSERT', 'UPDATE') AND to_jsonb(NEW) ? 'workspace_id' THEN
    target := (to_jsonb(NEW) ->> 'workspace_id')::uuid;
    IF (TG_OP = 'INSERT'
        OR target IS DISTINCT FROM (to_jsonb(OLD) ->> 'workspace_id')::uuid
        OR (coalesce((to_jsonb(NEW) ->> 'is_home')::boolean, false)
            AND NOT coalesce((to_jsonb(OLD) ->> 'is_home')::boolean, false)))
       AND NOT coalesce(target = ANY ("public"."mantle_scope_mod_ws"()), false)
       AND "public"."mantle_scoped_write_refuses"(
             format('%s on %s: not a Moderator of the workspace', TG_OP, TG_TABLE_NAME)) THEN
      RAISE EXCEPTION 'not allowed to grant to that workspace' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_canvas_data_put"(
  canvas uuid, in_bucket text, in_key text, in_json text)
  RETURNS TABLE ("result" text, "saved_at" timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  -- @mantle/content-core/canvas-data, pinned by packages/content/src/canvas-data.test.ts.
  value_max CONSTANT integer := 65536;
  canvas_max_bytes CONSTANT bigint := 1048576;
  canvas_max_keys CONSTANT bigint := 1000;
  mine_max_bytes CONSTANT bigint := 786432;
  mine_max_keys CONSTANT bigint := 750;
  login_max_bytes CONSTANT bigint := 262144;
  login_max_keys CONSTANT bigint := 200;
  me uuid := "public"."mantle_scope_login_id"();
  who uuid;
  nm text;
  sz integer;
  v jsonb;
  c record;
  ub bigint;
  uk bigint;
  ts timestamptz;
BEGIN
  IF NOT "public"."mantle_scope_active"() OR me IS NULL THEN
    RAISE EXCEPTION 'mantle_canvas_data_put: only in a login''s own scope' USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RETURN QUERY SELECT 'ro'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF in_bucket IS NULL OR in_bucket NOT IN ('shared', 'mine')
     OR in_key IS NULL OR in_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
     OR in_json IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::timestamptz;
    RETURN;
  END IF;
  -- A first bound, before the parse: the value as stored is never shorter
  -- than the compact text the content layer sends.
  IF octet_length(in_json) > value_max THEN
    RETURN QUERY SELECT 'too_big'::text, NULL::timestamptz;
    RETURN;
  END IF;
  BEGIN
    v := in_json::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::timestamptz;
    RETURN;
  END;
  -- The size every cap counts: the value as stored.
  sz := octet_length(v::text);
  IF sz > value_max THEN
    RETURN QUERY SELECT 'too_big'::text, NULL::timestamptz;
    RETURN;
  END IF;
  -- One writer per canvas at a time: the caps below count what is there.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canvas-data:' || canvas::text, 0));
  -- The canvas, held against a delete until this write commits.
  SELECT n."read_ws", n."home_ws", n."write_ws", n."login_id",
         coalesce(n."data" ? 'snapshot_of', false) AS copy
    INTO c
    FROM "public"."nodes" n
   WHERE n."id" = canvas AND n."type" = 'present'
     FOR KEY SHARE OF n;
  IF NOT FOUND
     OR NOT coalesce(c.read_ws && "public"."mantle_scope_ws"(), false)
     OR (c.login_id IS NOT NULL AND c.login_id IS DISTINCT FROM me) THEN
    RETURN QUERY SELECT 'missing'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF c.copy THEN
    RETURN QUERY SELECT 'read_only'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF in_bucket = 'shared' AND NOT coalesce("public"."mantle_may_edit"(c.home_ws, c.write_ws, c.read_ws, 'present'), false) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::timestamptz;
    RETURN;
  END IF;
  who := CASE WHEN in_bucket = 'mine' THEN me END;
  -- The caps, the row this write replaces left out.
  SELECT coalesce(sum(d."bytes"), 0), count(*) INTO ub, uk
    FROM "public"."canvas_data" d
   WHERE d."node_id" = canvas
     AND NOT (d."bucket" = in_bucket AND d."key" = in_key AND d."login_id" IS NOT DISTINCT FROM who);
  IF ub + sz > canvas_max_bytes OR uk + 1 > canvas_max_keys THEN
    RETURN QUERY SELECT 'full'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF in_bucket = 'mine' THEN
    SELECT coalesce(sum(d."bytes"), 0), count(*) INTO ub, uk
      FROM "public"."canvas_data" d
     WHERE d."node_id" = canvas AND d."bucket" = 'mine'
       AND NOT (d."key" = in_key AND d."login_id" = who);
    IF ub + sz > mine_max_bytes OR uk + 1 > mine_max_keys THEN
      RETURN QUERY SELECT 'full'::text, NULL::timestamptz;
      RETURN;
    END IF;
    SELECT coalesce(sum(d."bytes"), 0), count(*) INTO ub, uk
      FROM "public"."canvas_data" d
     WHERE d."node_id" = canvas AND d."bucket" = 'mine' AND d."login_id" = who
       AND d."key" <> in_key;
    IF ub + sz > login_max_bytes OR uk + 1 > login_max_keys THEN
      RETURN QUERY SELECT 'full'::text, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;
  SELECT left(nullif(btrim(u."display_name"), ''), 200) INTO nm
    FROM "auth"."users" u WHERE u."id" = me;
  IF in_bucket = 'shared' THEN
    INSERT INTO "public"."canvas_data" AS d
      ("node_id", "bucket", "key", "login_id", "value", "bytes", "updated_by", "by_name")
    VALUES (canvas, 'shared', in_key, NULL, v, sz, me, nm)
    ON CONFLICT ("node_id", "key") WHERE "bucket" = 'shared'
    DO UPDATE SET "value" = excluded."value", "bytes" = excluded."bytes",
                  "updated_by" = excluded."updated_by", "by_name" = excluded."by_name",
                  "updated_at" = now()
    RETURNING d."updated_at" INTO ts;
  ELSE
    INSERT INTO "public"."canvas_data" AS d
      ("node_id", "bucket", "key", "login_id", "value", "bytes", "updated_by", "by_name")
    VALUES (canvas, 'mine', in_key, who, v, sz, me, nm)
    ON CONFLICT ("node_id", "login_id", "key") WHERE "bucket" = 'mine'
    DO UPDATE SET "value" = excluded."value", "bytes" = excluded."bytes",
                  "updated_by" = excluded."updated_by", "by_name" = excluded."by_name",
                  "updated_at" = now()
    RETURNING d."updated_at" INTO ts;
  END IF;
  RETURN QUERY SELECT 'ok'::text, ts;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_canvas_data_delete"(
  canvas uuid, in_bucket text, in_key text, in_login uuid)
  RETURNS TABLE ("result" text, "removed" integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  me uuid := "public"."mantle_scope_login_id"();
  clear boolean := in_bucket IS NULL AND in_key IS NULL AND in_login IS NULL;
  who uuid;
  need_write boolean;
  c record;
  gone integer;
BEGIN
  IF NOT "public"."mantle_scope_active"() OR me IS NULL THEN
    RAISE EXCEPTION 'mantle_canvas_data_delete: only in a login''s own scope' USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RETURN QUERY SELECT 'ro'::text, 0;
    RETURN;
  END IF;
  IF NOT clear AND (
       in_bucket IS NULL OR in_bucket NOT IN ('shared', 'mine')
       OR in_key IS NULL OR in_key !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
       OR (in_bucket = 'shared' AND in_login IS NOT NULL)) THEN
    RETURN QUERY SELECT 'invalid'::text, 0;
    RETURN;
  END IF;
  who := CASE WHEN in_bucket = 'mine' THEN coalesce(in_login, me) END;
  need_write := clear OR in_bucket = 'shared' OR who IS DISTINCT FROM me;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canvas-data:' || canvas::text, 0));
  SELECT n."read_ws", n."home_ws", n."write_ws", n."login_id",
         coalesce(n."data" ? 'snapshot_of', false) AS copy
    INTO c
    FROM "public"."nodes" n
   WHERE n."id" = canvas AND n."type" = 'present';
  IF NOT FOUND
     OR NOT coalesce(c.read_ws && "public"."mantle_scope_ws"(), false)
     OR (c.login_id IS NOT NULL AND c.login_id IS DISTINCT FROM me) THEN
    RETURN QUERY SELECT 'missing'::text, 0;
    RETURN;
  END IF;
  IF c.copy THEN
    RETURN QUERY SELECT 'read_only'::text, 0;
    RETURN;
  END IF;
  IF need_write AND NOT coalesce("public"."mantle_may_edit"(c.home_ws, c.write_ws, c.read_ws, 'present'), false) THEN
    RETURN QUERY SELECT 'forbidden'::text, 0;
    RETURN;
  END IF;
  IF clear THEN
    DELETE FROM "public"."canvas_data" d WHERE d."node_id" = canvas;
  ELSE
    DELETE FROM "public"."canvas_data" d
     WHERE d."node_id" = canvas AND d."bucket" = in_bucket AND d."key" = in_key
       AND d."login_id" IS NOT DISTINCT FROM who;
  END IF;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN QUERY SELECT 'ok'::text, gone;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_default_home"(
  o uuid, t "public"."node_type", p ltree)
  RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  admin_ws uuid;
  home uuid;
  req uuid := "public"."mantle_setting_uuid"('mantle.create_ws');
  priv uuid := "public"."mantle_setting_uuid"('mantle.private_ws');
  fw uuid[];
  fr uuid[];
  ok boolean;
BEGIN
  IF o IS NULL OR o IS DISTINCT FROM "public"."mantle_brain_id"() THEN RETURN NULL; END IF;
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = o AND w."is_admin" LIMIT 1;
  IF admin_ws IS NULL THEN RETURN NULL; END IF;
  -- A kind's root folder is the brain's structure, whoever's request made
  -- it first: as before (0261).
  IF t = 'branch' AND nlevel(p) = 1 THEN
    req := NULL;
    priv := NULL;
  END IF;
  IF req IS NOT NULL
     AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."id" = req AND w."owner_id" = o AND w."archived_at" IS NULL)
     AND "public"."mantle_grant_kind_ok"(t, req) THEN
    RETURN req;
  END IF;
  IF "public"."mantle_kind_class"(t) <> 'workspace' THEN
    IF priv IS NOT NULL THEN
      RAISE EXCEPTION 'this kind of item lives in the Admin workspace only' USING ERRCODE = '42501';
    END IF;
    RETURN admin_ws;
  END IF;
  SELECT f."home_ws", f."write_ws", f."read_ws" INTO home, fw, fr FROM "public"."nodes" f
   WHERE f."id" = "public"."mantle_parent_folder"(o, t, p);
  ok := home IS NOT NULL
        AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                     WHERE w."id" = home AND w."archived_at" IS NULL)
        AND "public"."mantle_grant_kind_ok"(t, home);
  IF priv IS NOT NULL THEN
    IF ok AND (NOT "public"."mantle_scope_active"() OR coalesce("public"."mantle_may_edit"(home, fw, fr, 'branch'), false)) THEN
      RETURN home;
    END IF;
    IF EXISTS (SELECT 1 FROM "public"."workspaces" w
                WHERE w."id" = priv AND w."owner_id" = o AND w."archived_at" IS NULL) THEN
      RETURN priv;
    END IF;
    RAISE EXCEPTION 'no workspace to create this item in' USING ERRCODE = '42501';
  END IF;
  IF ok THEN RETURN home; END IF;
  RETURN admin_ws;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_may_add_to_folder"(
  o uuid, t "public"."node_type", p ltree)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT coalesce((SELECT "public"."mantle_may_add"(f."home_ws", f."write_ws", f."read_ws")
                     FROM "public"."nodes" f
                    WHERE f."id" = "public"."mantle_parent_folder"(o, t, p)), true)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_may_create_item"(
  o uuid, t "public"."node_type", p ltree)
  RETURNS boolean LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
DECLARE
  home uuid := "public"."mantle_default_home"(o, t, p);
  f record;
BEGIN
  -- No row yet: its home holds it, so that read is known (4).
  IF "public"."mantle_may_manage_home"(home, ARRAY[home]) THEN RETURN true; END IF;
  IF home IS NULL THEN RETURN false; END IF;
  SELECT n."home_ws", n."write_ws", n."read_ws" INTO f FROM "public"."nodes" n
   WHERE n."id" = "public"."mantle_parent_folder"(o, t, p);
  RETURN FOUND AND f."home_ws" = home
         AND "public"."mantle_may_add"(f."home_ws", f."write_ws", f."read_ws");
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_path_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  me xid8;
  moved uuid[];
  strict_ids uuid[];
  roots uuid[];
  renamed uuid[];
  folders uuid[];
  held uuid[];
  missing uuid;
  m record;
  root uuid;
BEGIN
  me := pg_current_xact_id_if_assigned();
  IF me IS NULL THEN RETURN NULL; END IF;
  WITH taken AS (
    DELETE FROM "public"."mantle_moved_nodes" t WHERE t."xid" = me
      RETURNING t."id", t."old_owner", t."old_path", t."old_system"
  ), classed AS (
    SELECT tk."id",
           coalesce((SELECT s."kind" = 'personal' FROM "public"."spaces" s
                      WHERE s."id" = tk."old_owner"), false) AS was_personal,
           coalesce((SELECT s."kind" = 'personal' FROM "public"."nodes" n
                       JOIN "public"."spaces" s ON s."id" = n."owner_id"
                      WHERE n."id" = tk."id"), false) AS is_personal,
           coalesce((SELECT "public"."mantle_is_folder_rename"(
                              tk."old_owner", tk."old_path", n."owner_id", n."path", n."type",
                              tk."old_system", n."data")
                       FROM "public"."nodes" n WHERE n."id" = tk."id"), false) AS is_rename
      FROM taken tk
  )
  SELECT coalesce(array_agg("id"), '{}'::uuid[]),
         coalesce(array_agg("id") FILTER (WHERE NOT (was_personal AND is_personal)), '{}'::uuid[]),
         coalesce(array_agg("id") FILTER (WHERE is_rename), '{}'::uuid[])
    INTO moved, strict_ids, renamed
    FROM classed;
  IF cardinality(moved) = 0 THEN RETURN NULL; END IF;

  SELECT coalesce(array_agg(n."id"), '{}'::uuid[]),
         coalesce(array_agg(DISTINCT pf."id") FILTER (WHERE pf."id" IS NOT NULL), '{}'::uuid[])
    INTO roots, folders
    FROM "public"."nodes" n
    LEFT JOIN "public"."nodes" pf
      ON pf."owner_id" = n."owner_id" AND pf."type" = 'branch'
     AND pf."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
   WHERE n."id" = ANY (moved)
     AND (pf."id" IS NULL OR NOT (pf."id" = ANY (moved)));

  -- Fix 1: a row that was or is a brain row needs its head held for update,
  -- wherever it lands. No personal-space exemption for it (0244 rule 1 reads
  -- the owner after the update, which is the hole this closes).
  IF cardinality(strict_ids) > 0 AND "public"."mantle_heads_check_mode"() <> 'off' THEN
    held := "public"."mantle_heads_held"(true);
    SELECT d.x INTO missing
      FROM (SELECT u.x FROM unnest(strict_ids) AS u(x)
            EXCEPT
            SELECT h.x FROM unnest(held) AS h(x)) d
     LIMIT 1;
    IF missing IS NOT NULL THEN
      PERFORM "public"."mantle_heads_miss"('nodes_move', missing, 'head not locked first for update');
    END IF;
  END IF;
  PERFORM "public"."mantle_heads_require"(folders, 'nodes_move_folder');

  IF "public"."mantle_scope_active"() THEN
    FOR m IN
      SELECT n."id", n."type", n."home_ws", n."write_ws", n."read_ws", pf."id" AS folder,
             pf."home_ws" AS f_home, pf."write_ws" AS f_write, pf."read_ws" AS f_read
        FROM "public"."nodes" n
        LEFT JOIN "public"."nodes" pf
          ON pf."owner_id" = n."owner_id" AND pf."type" = 'branch'
         AND pf."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
       WHERE n."id" = ANY (roots)
    LOOP
      IF m."id" = ANY (renamed) THEN
        -- A folder's rename: Write on it (S11a-6a). It stays in its folder.
        IF NOT coalesce("public"."mantle_may_edit"(m."home_ws", m."write_ws", m."read_ws", m."type"), false) THEN
          RAISE EXCEPTION 'not allowed to edit this item' USING ERRCODE = '42501';
        END IF;
        CONTINUE;
      END IF;
      -- A Moderator of its home, or of a workspace that holds both the item
      -- and the folder it lands in (a move inside that workspace, 0382).
      IF NOT ("public"."mantle_may_manage"(m."home_ws", m."read_ws")
              OR (m.folder IS NOT NULL AND "public"."mantle_mod_holds"(m."read_ws", m.f_read))) THEN
        RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501';
      END IF;
      IF m.folder IS NOT NULL AND NOT "public"."mantle_may_add"(m.f_home, m.f_write, m.f_read) THEN
        RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
      END IF;
      IF m."type" = 'app' AND m.folder IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(m.f_read) AS w
                      WHERE NOT (w = ANY (m."read_ws"))
                        AND NOT (w = ANY ("public"."mantle_scope_mod_ws"()))) THEN
        RAISE EXCEPTION 'placing this app adds a workspace you do not moderate' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;

  FOREACH root IN ARRAY roots LOOP
    PERFORM "public"."mantle_rederive_subtree"(root, true);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_subtree_rewrite"(o uuid, old_path ltree, new_path ltree)
  RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  f record;
  hidden uuid[];
  dest_read uuid[];
  n integer;
  -- A rename keeps the parent: the same depth and the same path above it.
  moving boolean := nlevel(old_path) <> nlevel(new_path)
                    OR subpath(old_path, 0, nlevel(old_path) - 1)
                       IS DISTINCT FROM subpath(new_path, 0, nlevel(new_path) - 1);
BEGIN
  SELECT x."id", x."home_ws", x."write_ws", x."read_ws", x."type", x."data" INTO f
    FROM "public"."nodes" x
   WHERE x."owner_id" = o AND x."type" = 'branch' AND x."path" = old_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mantle_subtree_rewrite: no folder at that path' USING ERRCODE = '22023';
  END IF;
  IF "public"."mantle_caller_is_write_role"() THEN
    -- A move inside a workspace (0382): the folder it lands in, as the move
    -- check reads it.
    SELECT p."read_ws" INTO dest_read FROM "public"."nodes" p
     WHERE p."owner_id" = o AND p."type" = 'branch'
       AND p."path" = "public"."mantle_parent_folder_path"('branch', new_path);
    IF NOT "public"."mantle_scope_active"()
       OR NOT ("public"."mantle_check_row"(f."home_ws", f."write_ws", f."read_ws",
                CASE WHEN "public"."mantle_is_folder_rename"(o, old_path, o, new_path, f."type",
                                                             coalesce((f."data" ->> 'system') = 'true', false),
                                                             f."data")
                     THEN 'edit' ELSE 'manage' END)
               OR (moving AND "public"."mantle_mod_holds"(f."read_ws", dest_read))) THEN
      RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501', DETAIL = 'no_edit';
    END IF;
    -- A move with rows the caller cannot read: refused (the owner's rule).
    -- A rename takes them along.
    IF moving THEN
      PERFORM "public"."mantle_subtree_refuse_hidden"(o, old_path);
    END IF;
    SELECT array_agg(x."id" ORDER BY x."id") INTO hidden
      FROM "public"."nodes" x
     WHERE x."owner_id" = o AND x."path" <@ old_path
       AND NOT "public"."mantle_check_row"(x."home_ws", x."write_ws", x."read_ws", 'read');
    IF hidden IS NOT NULL AND "public"."mantle_heads_taken"() THEN
      PERFORM "public"."mantle_lock_heads_more_core"(hidden);
    END IF;
  END IF;
  -- The apps inside a moved folder (0282, 3): staged, and skipped off.
  IF moving AND "public"."mantle_scope_active"() AND "public"."mantle_edit_check_mode"() <> 'off' THEN
    -- The folder it lands in, as the re-derive finds it: none at a tree's
    -- top level (a kind's root row passes no grants), so nothing is added.
    SELECT p."read_ws" INTO dest_read FROM "public"."nodes" p
     WHERE p."owner_id" = o AND p."type" = 'branch'
       AND p."path" = "public"."mantle_parent_folder_path"('branch', new_path);
    IF FOUND AND EXISTS (
      SELECT 1 FROM "public"."nodes" a, unnest(dest_read) AS w
       WHERE a."owner_id" = o AND a."type" = 'app' AND a."path" <@ old_path
         AND NOT (w = ANY (a."read_ws"))
         AND NOT (w = ANY ("public"."mantle_scope_mod_ws"()))
         AND NOT EXISTS (
           SELECT 1 FROM "public"."item_grants" g
             JOIN "public"."nodes" c ON c."id" = g."node_id"
            WHERE g."workspace_id" = w AND g."excluded"
              AND c."owner_id" = o AND c."path" <@ old_path
              AND (c."id" = a."id" OR (c."type" = 'branch' AND a."path" <@ c."path")))) THEN
      PERFORM "public"."mantle_edit_refuse"(
        'UPDATE on nodes: a move adds a workspace to an app inside it, not moderated', 'no_edit',
        'placing this app adds a workspace you do not moderate');
    END IF;
  END IF;
  UPDATE "public"."nodes"
     SET "path" = CASE WHEN "path" = old_path THEN new_path
                       ELSE (new_path || subpath("path", nlevel(old_path)))::ltree END
   WHERE "owner_id" = o AND "path" <@ old_path;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
--> statement-breakpoint
ALTER POLICY "canvas_data_user_read" ON "public"."canvas_data"
  USING (EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = "canvas_data"."node_id"
       AND ("canvas_data"."bucket" = 'shared'
            OR "canvas_data"."login_id" = (SELECT "public"."mantle_login_id"())
            OR coalesce("public"."mantle_may_edit"(n."home_ws", n."write_ws", n."read_ws", n."type"), false))));
--> statement-breakpoint
-- 4. The other callers of manage, each passing its row's read_ws: the
-- grant definers (0279, 0291, 0307), the scope's delete check (0279), a
-- deleted app's purge and restore (0310: no row is left, so its snapshot's
-- home, ARRAY[home]), and an app's exports and timers (0302, 0355). The
-- write role's rules on those two are its read rule, which
-- mantle_write_role_sync_table writes after the migrations (a new database
-- has none yet): dropped here, so the old manage can go, and written again
-- from the new read rule by that sync.
CREATE OR REPLACE FUNCTION "public"."mantle_app_trash_act"(app uuid, act text)
  RETURNS TABLE (outcome text, seq integer, code jsonb, db_path text,
                 schema_version integer, member_era boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_variable
DECLARE
  brain uuid := "public"."mantle_admin_act_brain"('mantle_app_trash_act');
  owner boolean := "public"."mantle_scope_login_id"() = brain;
  s_seq integer;
  s_code jsonb;
  s_db text;
  s_schema integer;
  home text;
  held boolean;
  may boolean;
BEGIN
  IF act IS NULL OR act NOT IN ('purge', 'restore') THEN
    RAISE EXCEPTION 'mantle_app_trash_act: act % is neither purge nor restore', act
      USING ERRCODE = '22023';
  END IF;
  SELECT s."seq", s."code", s."db_path", s."schema_version",
         nullif(s."code" -> 'meta' ->> 'homeWs', ''),
         coalesce((s."code" -> 'meta' ->> 'keepForOwner')::boolean, false)
    INTO s_seq, s_code, s_db, s_schema, home, held
    FROM "public"."node_snapshots" s
   WHERE s."owner_id" = brain AND s."node_id" = app AND s."node_kind" = 'app'
     AND s."trigger" = 'pre_delete'
     AND NOT EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n."id" = s."node_id")
   ORDER BY s."seq" DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not-found'::text, NULL::integer, NULL::jsonb, NULL::text,
                        NULL::integer, NULL::boolean;
    RETURN;
  END IF;
  -- The owner purges an app another login deleted, whatever its home.
  IF NOT (act = 'purge' AND held AND owner) THEN
    may := owner AND home IS NULL;
    IF home IS NOT NULL THEN
      -- No row is left: its home held it, the one read known (0382).
      may := coalesce("public"."mantle_may_manage"(home::uuid, ARRAY[home::uuid]), false);
    END IF;
    IF NOT may THEN
      RETURN QUERY SELECT 'not-found'::text, NULL::integer, NULL::jsonb, NULL::text,
                          NULL::integer, NULL::boolean;
      RETURN;
    END IF;
    IF act = 'purge' AND held THEN
      RETURN QUERY SELECT 'held'::text, NULL::integer, NULL::jsonb, NULL::text,
                          NULL::integer, NULL::boolean;
      RETURN;
    END IF;
  END IF;
  IF act = 'purge' THEN
    DELETE FROM "public"."node_snapshots" x WHERE x."owner_id" = brain AND x."node_id" = app;
    RETURN QUERY SELECT 'purged'::text, NULL::integer, NULL::jsonb, NULL::text,
                        NULL::integer, NULL::boolean;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'restore'::text, s_seq, s_code, s_db, s_schema,
    EXISTS (SELECT 1 FROM "public"."node_snapshots" m
             WHERE m."node_id" = app AND m."actor" = 'member');
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_grant_change"(
  op text, node uuid, ws uuid, w boolean, actor uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  home uuid;
  rd uuid[];
  row_home boolean;
  manage boolean;
  moderates boolean;
  ok boolean;
  who uuid := coalesce("public"."mantle_login_id"(), actor);
BEGIN
  IF op IS NULL OR op NOT IN ('add', 'exclude', 'hand', 'write', 'remove', 'restore') THEN
    RAISE EXCEPTION 'mantle_grant_change: unknown op %', op USING ERRCODE = '22023';
  END IF;
  SELECT n."home_ws", n."read_ws" INTO home, rd FROM "public"."nodes" n
   WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501';
  END IF;
  SELECT g."is_home" INTO row_home FROM "public"."item_grants" g
   WHERE g."node_id" = node AND g."workspace_id" = ws;
  manage := "public"."mantle_may_manage_home"(home, rd);
  moderates := coalesce(ws = ANY ("public"."mantle_scope_mod_ws"()), false);
  ok := CASE
          WHEN op IN ('exclude', 'remove') THEN manage OR moderates
          WHEN op = 'write' AND coalesce(row_home, false) THEN manage
          WHEN op = 'write' AND NOT coalesce(w, false) THEN manage OR moderates
          ELSE manage AND moderates
        END;
  PERFORM "public"."mantle_grant_refuses"(ok, format('%s on item_grants: no right to change this grant', op),
    CASE WHEN manage THEN 'not allowed to grant to that workspace' ELSE 'not allowed to change this item' END);
  IF op = 'add' THEN
    IF row_home IS NULL THEN
      INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "granted_by")
      VALUES (node, ws, coalesce(w, false), who);
    ELSE
      UPDATE "public"."item_grants"
         SET "excluded" = false, "via_folder_id" = NULL, "write" = coalesce(w, false),
             "granted_by" = who, "granted_at" = now()
       WHERE "node_id" = node AND "workspace_id" = ws;
    END IF;
  ELSIF op = 'exclude' THEN
    UPDATE "public"."item_grants"
       SET "excluded" = true, "write" = false, "via_folder_id" = NULL,
           "granted_by" = who, "granted_at" = now()
     WHERE "node_id" = node AND "workspace_id" = ws;
  ELSIF op = 'hand' THEN
    UPDATE "public"."item_grants"
       SET "via_folder_id" = NULL, "granted_by" = who, "granted_at" = now()
     WHERE "node_id" = node AND "workspace_id" = ws;
  ELSIF op = 'write' THEN
    UPDATE "public"."item_grants" SET "write" = coalesce(w, false)
     WHERE "node_id" = node AND "workspace_id" = ws;
  ELSE
    DELETE FROM "public"."item_grants" WHERE "node_id" = node AND "workspace_id" = ws;
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_grant_move_home"(
  node uuid, to_ws uuid, keep_old boolean, actor uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  from_ws uuid;
  rd uuid[];
  who uuid := coalesce("public"."mantle_login_id"(), actor);
BEGIN
  SELECT n."read_ws" INTO rd FROM "public"."nodes" n
   WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501';
  END IF;
  SELECT g."workspace_id" INTO from_ws FROM "public"."item_grants" g
   WHERE g."node_id" = node AND g."is_home";
  PERFORM "public"."mantle_grant_refuses"("public"."mantle_may_manage_home"(from_ws, rd),
    'UPDATE on item_grants: a home move, no manage of the home', 'not allowed to move this item');
  PERFORM "public"."mantle_grant_refuses"(coalesce(to_ws = ANY ("public"."mantle_scope_mod_ws"()), false),
    'UPDATE on item_grants: a home move, not a Moderator of the workspace',
    'not allowed to grant to that workspace');
  IF from_ws IS NOT DISTINCT FROM to_ws THEN RETURN; END IF;
  -- The old home row first: the one-home index is not deferrable.
  UPDATE "public"."item_grants" SET "is_home" = false
   WHERE "node_id" = node AND "workspace_id" = from_ws;
  IF EXISTS (SELECT 1 FROM "public"."item_grants" g
              WHERE g."node_id" = node AND g."workspace_id" = to_ws) THEN
    UPDATE "public"."item_grants"
       SET "is_home" = true, "via_folder_id" = NULL,
           "write" = CASE WHEN "excluded" THEN false ELSE "write" END,
           "excluded" = false, "granted_by" = who, "granted_at" = now()
     WHERE "node_id" = node AND "workspace_id" = to_ws;
  ELSE
    INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "is_home", "granted_by")
    VALUES (node, to_ws, false, true, who);
  END IF;
  IF from_ws IS NOT NULL THEN
    IF keep_old THEN
      UPDATE "public"."item_grants" SET "write" = false
       WHERE "node_id" = node AND "workspace_id" = from_ws;
    ELSE
      DELETE FROM "public"."item_grants" WHERE "node_id" = node AND "workspace_id" = from_ws;
    END IF;
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_scope_delete_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR NOT "public"."mantle_scope_active"() THEN
    RETURN OLD;
  END IF;
  IF OLD."home_ws" IS NOT NULL AND NOT "public"."mantle_may_manage"(OLD."home_ws", OLD."read_ws") THEN
    RAISE EXCEPTION 'not allowed to delete this item' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_grant_counts"(
  node uuid, add_ws uuid, remove_ws uuid, mine uuid[])
  RETURNS TABLE ("total" integer, "gain" integer, "gain_apps" integer, "lose" integer,
                 "hidden" integer, "exports" integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH x AS (
    SELECT n."id", n."owner_id", n."path", n."type",
           CASE WHEN "public"."mantle_scope_active"() THEN "public"."mantle_scope_ws"()
                ELSE coalesce(mine, '{}'::uuid[]) END AS ws
      FROM "public"."nodes" n
     WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"()
       AND (NOT "public"."mantle_scope_active"()
            OR (n."read_ws" && "public"."mantle_scope_ws"()
                AND (n."login_id" IS NULL OR n."login_id" = "public"."mantle_scope_login_id"())
                AND (add_ws IS NULL
                     OR (coalesce("public"."mantle_may_manage"(n."home_ws", n."read_ws"), false)
                         AND add_ws = ANY ("public"."mantle_scope_mod_ws"())))
                AND (remove_ws IS NULL
                     OR coalesce("public"."mantle_may_manage"(n."home_ws", n."read_ws"), false)
                     OR remove_ws = ANY ("public"."mantle_scope_mod_ws"()))
                AND (add_ws IS NOT NULL OR remove_ws IS NOT NULL
                     OR coalesce("public"."mantle_may_manage"(n."home_ws", n."read_ws"), false)
                     OR n."read_ws" && "public"."mantle_scope_mod_ws"())))
  ),
  sub AS (
    SELECT d."id", d."type", d."path", d."read_ws" FROM "public"."nodes" d, x
     WHERE d."owner_id" = x."owner_id"
       AND (d."id" = x."id" OR (x."type" = 'branch' AND d."path" <@ x."path"))
  )
  SELECT
    CASE WHEN x."type" = 'branch' AND x."path" IS NOT NULL
         THEN (SELECT count(*)::int FROM "public"."nodes" t
                WHERE t."owner_id" = x."owner_id" AND t."path" <@ x."path")
         ELSE 1 END,
    CASE WHEN add_ws IS NULL THEN 0 ELSE (
      SELECT count(*)::int FROM sub d
       WHERE NOT EXISTS (SELECT 1 FROM "public"."item_grants" g
                          WHERE g."node_id" = d."id" AND g."workspace_id" = add_ws
                            AND NOT g."excluded")
         AND (d."id" = x."id" OR (
               NOT EXISTS (SELECT 1 FROM "public"."item_grants" g
                            WHERE g."node_id" = d."id" AND g."workspace_id" = add_ws)
               AND "public"."mantle_grant_kind_ok"(d."type", add_ws, true)
               AND NOT EXISTS (
                 SELECT 1 FROM "public"."nodes" a
                   JOIN "public"."item_grants" ag ON ag."node_id" = a."id"
                                                 AND ag."workspace_id" = add_ws AND ag."excluded"
                  WHERE a."owner_id" = x."owner_id" AND a."type" = 'branch'
                    AND a."path" <@ x."path" AND a."id" <> x."id" AND a."id" <> d."id"
                    AND d."path" <@ a."path")))) END,
    CASE WHEN add_ws IS NULL THEN 0 ELSE (
      SELECT count(*)::int FROM sub d
       WHERE d."type" = 'app'
         AND NOT EXISTS (SELECT 1 FROM "public"."item_grants" g
                          WHERE g."node_id" = d."id" AND g."workspace_id" = add_ws
                            AND NOT g."excluded")
         AND (d."id" = x."id" OR (
               NOT EXISTS (SELECT 1 FROM "public"."item_grants" g
                            WHERE g."node_id" = d."id" AND g."workspace_id" = add_ws)
               AND "public"."mantle_grant_kind_ok"(d."type", add_ws, true)
               AND NOT EXISTS (
                 SELECT 1 FROM "public"."nodes" a
                   JOIN "public"."item_grants" ag ON ag."node_id" = a."id"
                                                 AND ag."workspace_id" = add_ws AND ag."excluded"
                  WHERE a."owner_id" = x."owner_id" AND a."type" = 'branch'
                    AND a."path" <@ x."path" AND a."id" <> x."id" AND a."id" <> d."id"
                    AND d."path" <@ a."path")))) END,
    CASE WHEN remove_ws IS NULL THEN 0 ELSE (
      SELECT count(*)::int FROM sub d
       WHERE EXISTS (SELECT 1 FROM "public"."item_grants" g
                      WHERE g."node_id" = d."id" AND g."workspace_id" = remove_ws
                        AND NOT g."excluded"
                        AND ((d."id" = x."id" AND NOT g."is_home")
                             OR (d."id" <> x."id" AND g."via_folder_id" IS NOT NULL)))
         AND (d."id" = x."id" OR NOT EXISTS (
               SELECT 1 FROM "public"."nodes" a
                 JOIN "public"."item_grants" ag ON ag."node_id" = a."id"
                                               AND ag."workspace_id" = remove_ws
                                               AND NOT ag."excluded" AND ag."via_folder_id" IS NULL
                WHERE a."owner_id" = x."owner_id" AND a."type" = 'branch'
                  AND a."path" <@ x."path" AND a."id" <> x."id" AND a."id" <> d."id"
                  AND d."path" <@ a."path"))) END,
    CASE WHEN x."type" = 'branch' AND x."path" IS NOT NULL
         THEN (SELECT count(*)::int FROM "public"."nodes" h
                WHERE h."owner_id" = x."owner_id" AND h."path" <@ x."path"
                  AND NOT coalesce(h."read_ws" && x.ws, false))
         ELSE 0 END,
    CASE WHEN x."type" = 'app'
         THEN (SELECT count(*)::int FROM "public"."app_table_exports" e
                WHERE e."app_node_id" = x."id")
         ELSE 0 END
    FROM x
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_item_grants"(node uuid)
  RETURNS TABLE ("workspace_id" uuid, "name" text, "write" boolean, "is_home" boolean,
                 "via_folder_id" uuid, "excluded" boolean, "archived" boolean,
                 "derivable" boolean, "parent_folder" uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH i AS (
    SELECT n."id", n."type",
           "public"."mantle_parent_folder"(n."owner_id", n."type", n."path") AS parent,
           (NOT "public"."mantle_scope_active"()
            OR coalesce("public"."mantle_may_manage"(n."home_ws", n."read_ws"), false)
            OR "public"."mantle_scope_has_area"('users')) AS wide
      FROM "public"."nodes" n
     WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"()
       AND (NOT "public"."mantle_scope_active"()
            OR (n."read_ws" && "public"."mantle_scope_ws"()
                AND (n."login_id" IS NULL OR n."login_id" = "public"."mantle_scope_login_id"())))
  )
  SELECT g."workspace_id", w."name", g."write", g."is_home", g."via_folder_id", g."excluded",
         w."archived_at" IS NOT NULL,
         (i.parent IS NOT NULL
          AND EXISTS (SELECT 1 FROM "public"."item_grants" fg
                       WHERE fg."node_id" = i.parent AND fg."workspace_id" = g."workspace_id"
                         AND NOT fg."excluded")
          AND "public"."mantle_grant_kind_ok"(i."type", g."workspace_id", true)),
         i.parent
    FROM i
    JOIN "public"."item_grants" g ON g."node_id" = i."id"
    JOIN "public"."workspaces" w ON w."id" = g."workspace_id"
   WHERE NOT g."excluded" OR i.wide OR g."workspace_id" = ANY ("public"."mantle_scope_ws"())
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_workspace_event"(
  ws uuid, actor uuid, action text, subject jsonb)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  node uuid;
BEGIN
  IF "public"."mantle_scope_login_id"() IS NULL
     AND NOT "public"."mantle_ws_system_work"('mantle_workspace_event') THEN
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
        SELECT "public"."mantle_may_manage_home"(n."home_ws", n."read_ws") FROM "public"."nodes" n
         WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"()), false),
      'workspace_events: a workspace outside the scope',
      'not allowed to grant to that workspace');
  END IF;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  VALUES (ws, coalesce("public"."mantle_login_id"(), actor), action, subject);
END
$$;
--> statement-breakpoint
ALTER POLICY "app_table_exports_user_read" ON "public"."app_table_exports"
  USING (EXISTS (
    SELECT 1 FROM "public"."nodes" a
     WHERE a."id" = "app_table_exports"."app_node_id"
       AND "public"."mantle_may_manage_home"(a."home_ws", a."read_ws")));
--> statement-breakpoint
DROP POLICY IF EXISTS "app_table_exports_write_insert" ON "public"."app_table_exports";
--> statement-breakpoint
DROP POLICY IF EXISTS "app_table_exports_write_update" ON "public"."app_table_exports";
--> statement-breakpoint
DROP POLICY IF EXISTS "app_table_exports_write_delete" ON "public"."app_table_exports";
--> statement-breakpoint
ALTER POLICY "app_timers_user_read" ON "public"."app_timers"
  USING (EXISTS (
    SELECT 1 FROM "public"."nodes" a
     WHERE a."id" = "app_timers"."app_node_id"
       AND "public"."mantle_may_manage_home"(a."home_ws", a."read_ws")));
--> statement-breakpoint
DROP POLICY IF EXISTS "app_timers_write_insert" ON "public"."app_timers";
--> statement-breakpoint
DROP POLICY IF EXISTS "app_timers_write_update" ON "public"."app_timers";
--> statement-breakpoint
DROP POLICY IF EXISTS "app_timers_write_delete" ON "public"."app_timers";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_check_row"(uuid, uuid[], uuid[], text, "public"."node_type", boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_may_add_to_folder"(uuid, "public"."node_type", ltree) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_may_create_item"(uuid, "public"."node_type", ltree) FROM PUBLIC;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_may_edit"(uuid, uuid[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_may_edit_in"(uuid[], uuid[], uuid, uuid[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_may_manage_home"(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_may_manage"(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_may_manage_in"(uuid[], uuid);
