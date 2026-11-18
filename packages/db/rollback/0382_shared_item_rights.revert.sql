-- Rollback of 0382_shared_item_rights: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Needed: the older image asks mantle_may_edit(home, write_ws) and
-- mantle_may_edit_in(ws, mod_ws, home, write_ws), which 0382 drops. This puts
-- back the old rule (a Moderator of the home, or a grant with Write on), the
-- 0279/0280/0305/0338/0352/0267 bodies 0382 replaced, the canvas data read
-- rule, and drops what 0382 added.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0382_shared_item_rights.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_may_edit_in"(ws uuid[], mod_ws uuid[], home uuid, write_ws uuid[])
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (home IS NOT NULL AND home = ANY (mod_ws)) OR coalesce(write_ws && ws, false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_may_edit"(home uuid, write_ws uuid[])
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT "public"."mantle_may_edit_in"("public"."mantle_scope_ws"(), "public"."mantle_scope_mod_ws"(), home, write_ws)
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
    WHEN 'edit' THEN coalesce("public"."mantle_may_edit"(home, write_ws), false)
    WHEN 'manage' THEN "public"."mantle_may_manage_home"(home)
    WHEN 'admin' THEN "public"."mantle_scope_has_admin"()
    WHEN 'appdata' THEN coalesce("public"."mantle_may_edit"(home, write_ws), false)
                        AND (NOT coalesce(informational, false) OR "public"."mantle_scope_has_admin"())
    WHEN 'link' THEN CASE WHEN "public"."mantle_link_needs_manage"(kind)
                          THEN "public"."mantle_may_manage_home"(home)
                          ELSE coalesce("public"."mantle_may_edit"(home, write_ws), false) END
    WHEN 'link_close' THEN (CASE WHEN "public"."mantle_link_needs_manage"(kind)
                                 THEN "public"."mantle_may_manage_home"(home)
                                 ELSE coalesce("public"."mantle_may_edit"(home, write_ws), false) END)
                           OR "public"."mantle_scope_has_area"('users')
    ELSE NULL
  END;
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
  IF in_bucket = 'shared' AND NOT coalesce("public"."mantle_may_edit"(c.home_ws, c.write_ws), false) THEN
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
  IF need_write AND NOT coalesce("public"."mantle_may_edit"(c.home_ws, c.write_ws), false) THEN
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
  SELECT f."home_ws", f."write_ws" INTO home, fw FROM "public"."nodes" f
   WHERE f."id" = "public"."mantle_parent_folder"(o, t, p);
  ok := home IS NOT NULL
        AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                     WHERE w."id" = home AND w."archived_at" IS NULL)
        AND "public"."mantle_grant_kind_ok"(t, home);
  IF priv IS NOT NULL THEN
    IF ok AND (NOT "public"."mantle_scope_active"() OR coalesce("public"."mantle_may_edit"(home, fw), false)) THEN
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
  SELECT coalesce((SELECT coalesce("public"."mantle_may_edit"(f."home_ws", f."write_ws"), false)
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
  IF "public"."mantle_may_manage_home"(home) THEN RETURN true; END IF;
  IF home IS NULL THEN RETURN false; END IF;
  SELECT n."home_ws", n."write_ws" INTO f FROM "public"."nodes" n
   WHERE n."id" = "public"."mantle_parent_folder"(o, t, p);
  RETURN FOUND AND f."home_ws" = home
         AND coalesce("public"."mantle_may_edit"(f."home_ws", f."write_ws"), false);
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
        IF NOT coalesce("public"."mantle_may_edit"(m."home_ws", m."write_ws"), false) THEN
          RAISE EXCEPTION 'not allowed to edit this item' USING ERRCODE = '42501';
        END IF;
        CONTINUE;
      END IF;
      IF NOT "public"."mantle_may_manage"(m."home_ws") THEN
        RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501';
      END IF;
      IF m.folder IS NOT NULL AND NOT "public"."mantle_may_edit"(m.f_home, m.f_write) THEN
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
    IF NOT "public"."mantle_scope_active"()
       OR NOT "public"."mantle_check_row"(f."home_ws", f."write_ws", f."read_ws",
                CASE WHEN "public"."mantle_is_folder_rename"(o, old_path, o, new_path, f."type",
                                                             coalesce((f."data" ->> 'system') = 'true', false),
                                                             f."data")
                     THEN 'edit' ELSE 'manage' END) THEN
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
            OR coalesce("public"."mantle_may_edit"(n."home_ws", n."write_ws"), false))));
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_may_edit"(uuid, uuid[], uuid[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_may_edit_in"(uuid[], uuid[], uuid, uuid[], uuid[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_may_add"(uuid, uuid[], uuid[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_mod_holds"(uuid[], uuid[]);
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792130000000;
