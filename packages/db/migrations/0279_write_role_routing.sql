-- Workspaces arch A2b2b (plan v2 page fcc4aee4, sections 18.8 and 20.1;
-- docs/actors.md, "Closed in A2b2b"): login writes now run on the write role
-- (mantle_write_user) while the box is warn or on. What that needs here:
--
-- 1. Two helpers, so each rule is written once:
--     - mantle_may_manage_home(home): manage of the home, or an Admin scope
--       for an item with no home (0278 wrote it inline twice);
--     - mantle_may_add_to_folder(owner, type, path): the scope may edit the
--       folder a new item lands in, or there is none (0266 4a);
--     - mantle_may_create_item(owner, type, path): the write check's create
--       rule: a Moderator of the home mantle_default_home gives the item, or
--       that home is its folder's and the scope may edit the folder.
-- 2. The checks that refused a scoped login write on the system pool before
--    A2b2b keep refusing on the write role in every mode: the 0266 create
--    in a folder and delete checks and the 0245 move check (manage of the
--    home, edit of the new folder, an app placed where it adds a workspace
--    the caller does not moderate). 0277 and 0278 had staged them on the
--    write role (off and warn only report), but the app holds no check of
--    its own for some of them (an Admin user's create, move or delete in a
--    workspace it is not in: W6a M1), so staging them would let in warn
--    what the system pool refuses today. Only the write role's own new
--    checks (the write check, below) are staged by mantle_scoped_write_refuses.
-- 3. The write check (mantle_write_check_trg) uses the helpers. A create
--    checks its folder first and refuses as 0266 does, so a refused create
--    reports no staged miss before it fails.
-- 4. Grant writes through definer functions, so a caller on the write role
--    never writes item_grants.via_folder_id, granted_by or granted_at (not
--    the role's to write, A2b2a) nor workspace_events (no right):
--     - mantle_grant_change(op, node, ws, write, actor): one grant row, by
--       the rules of the grants panel (server/web/lib/grants.ts);
--     - mantle_grant_move_home(node, to, keep_old, actor): a home move in
--       one call: manage of the old home and a Moderator of the new one.
--       Never one UPDATE setting is_home on both rows: the unique index
--       item_grants_one_home_uq is not deferrable and is checked row by row,
--       so such an UPDATE can fail with 23505 by row order. Here the old
--       home row is cleared first, then the new one set;
--     - mantle_workspace_event(ws, actor, action, subject): a grant's audit
--       row (grant.* actions only), while a scope is set only in a
--       workspace of the scope, or for an item whose home it manages
--       (subject's node; A2b2b fix round 1, L5).
-- 5. What a write's visibility confirm reads of workspaces outside the
--    scope (packages/content/src/tree/visibility.ts, A2b2b fix round 1,
--    M3): it reads in the write's own transaction, and on the write role
--    (or the workspace role) the workspaces row rule hides every workspace
--    the scope is not in (a folder homed in Team for a member who only
--    edits it), and the item_grants row rule hides every grant row of a
--    workspace outside the scope. Four definers, each held to the scope:
--     - mantle_folder_grant_rows(folder): the folder's grant rows (the
--       workspace, write, home, excluded), only for a folder the scope
--       reads (all of them for an Admin scope, or with no scope set);
--     - mantle_ws_admin_id(owner): the brain's Admin workspace (an id);
--     - mantle_ws_live(ws): the workspace is live (not archived), and
--     - mantle_ws_names(ids): [{wsId, name}], by name: both only for a
--       workspace the scope holds, one that holds a grant on an item the
--       scope reads, or any for an Admin scope (or with no scope set).
--    Open to the workspace role (the write role mirrors its function
--    rights, access-matrix.ts applyViewerGrants), never to PUBLIC.
--
-- Re-runnable.

-- 1. The helpers.
CREATE OR REPLACE FUNCTION "public"."mantle_may_manage_home"(home uuid)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT CASE WHEN home IS NULL THEN "public"."mantle_scope_has_admin"()
              ELSE coalesce("public"."mantle_may_manage"(home), false) END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_may_manage_home"(uuid) FROM PUBLIC;
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
REVOKE ALL ON FUNCTION "public"."mantle_may_add_to_folder"(uuid, "public"."node_type", ltree) FROM PUBLIC;
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
REVOKE ALL ON FUNCTION "public"."mantle_may_create_item"(uuid, "public"."node_type", ltree) FROM PUBLIC;
--> statement-breakpoint

-- 2. The checks that refused before A2b2b refuse in every mode again.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_scope_create_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR NOT "public"."mantle_scope_active"() THEN
    RETURN NEW;
  END IF;
  IF NOT "public"."mantle_may_add_to_folder"(NEW."owner_id", NEW."type", NEW."path") THEN
    RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_scope_create_trg"() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_scope_delete_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR NOT "public"."mantle_scope_active"() THEN
    RETURN OLD;
  END IF;
  IF OLD."home_ws" IS NOT NULL AND NOT "public"."mantle_may_manage"(OLD."home_ws") THEN
    RAISE EXCEPTION 'not allowed to delete this item' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_scope_delete_trg"() FROM PUBLIC;
--> statement-breakpoint

-- The move check, as 0245 had it (0278's body, the refusals not staged).
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_path_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  me xid8;
  moved uuid[];
  strict_ids uuid[];
  roots uuid[];
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
      RETURNING t."id", t."old_owner"
  ), classed AS (
    SELECT tk."id",
           coalesce((SELECT s."kind" = 'personal' FROM "public"."spaces" s
                      WHERE s."id" = tk."old_owner"), false) AS was_personal,
           coalesce((SELECT s."kind" = 'personal' FROM "public"."nodes" n
                       JOIN "public"."spaces" s ON s."id" = n."owner_id"
                      WHERE n."id" = tk."id"), false) AS is_personal
      FROM taken tk
  )
  SELECT coalesce(array_agg("id"), '{}'::uuid[]),
         coalesce(array_agg("id") FILTER (WHERE NOT (was_personal AND is_personal)), '{}'::uuid[])
    INTO moved, strict_ids
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
      SELECT n."id", n."type", n."home_ws", n."read_ws", pf."id" AS folder,
             pf."home_ws" AS f_home, pf."write_ws" AS f_write, pf."read_ws" AS f_read
        FROM "public"."nodes" n
        LEFT JOIN "public"."nodes" pf
          ON pf."owner_id" = n."owner_id" AND pf."type" = 'branch'
         AND pf."path" = "public"."mantle_parent_folder_path"(n."type", n."path")
       WHERE n."id" = ANY (roots)
    LOOP
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
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_acl_path_trg"() FROM PUBLIC;
--> statement-breakpoint

-- 3. The write check (0278), with the helpers; a create checks its folder
--    first, as 0266 does in every mode.
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
      -- The home the item gets: nodes_acl_before_ins fires after this
      -- trigger (by name) and sets it from the same function, with the same
      -- settings, in the same statement.
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
      ok := coalesce("public"."mantle_may_edit"(OLD."home_ws", OLD."write_ws"), false);
      IF NOT ok THEN
        -- Stored generated columns are not computed yet in a BEFORE
        -- trigger's NEW: left out of the rank-only comparison.
        generated := ARRAY(SELECT a."attname"::text FROM pg_attribute a
                            WHERE a."attrelid" = TG_RELID AND a."attgenerated" <> '');
        IF (to_jsonb(NEW) - generated - 'data' - 'updated_at')
             = (to_jsonb(OLD) - generated - 'data' - 'updated_at')
           AND (coalesce(NEW."data", '{}'::jsonb) - 'rank') = (coalesce(OLD."data", '{}'::jsonb) - 'rank') THEN
          SELECT p."home_ws", p."write_ws" INTO f FROM "public"."nodes" p
           WHERE p."id" = "public"."mantle_parent_folder"(OLD."owner_id", OLD."type", OLD."path");
          ok := FOUND AND coalesce("public"."mantle_may_edit"(f."home_ws", f."write_ws"), false);
        END IF;
      END IF;
      IF NOT ok AND "public"."mantle_scoped_write_refuses"('UPDATE on nodes: no edit of the item') THEN
        RAISE EXCEPTION 'not allowed to edit this item' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD."home_ws" IS NULL AND NOT "public"."mantle_may_manage_home"(NULL)
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
      SELECT x."home_ws", x."write_ws" INTO n FROM "public"."nodes" x WHERE x."id" = item;
      IF NOT FOUND THEN
        ok := true; -- no such item: its foreign key refuses the row
      ELSIF kind = 'manage' THEN
        ok := "public"."mantle_may_manage_home"(n."home_ws");
      ELSE
        ok := coalesce("public"."mantle_may_edit"(n."home_ws", n."write_ws"), false);
      END IF;
    END IF;
    IF NOT ok AND "public"."mantle_scoped_write_refuses"(
         format('%s on %s: no %s of the item', TG_OP, TG_TABLE_NAME, kind)) THEN
      RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- A new grant, one moved to another workspace, or one made the home: a
  -- Moderator of its workspace.
  IF kind = 'manage' AND TG_OP IN ('INSERT', 'UPDATE') THEN
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
REVOKE ALL ON FUNCTION "public"."mantle_write_check_trg"() FROM PUBLIC;
--> statement-breakpoint

-- 4. Grant writes. Whether a scoped caller's grant change stands: true when
--    allowed; a refusal raises (staged on the write role).
CREATE OR REPLACE FUNCTION "public"."mantle_grant_refuses"(ok boolean, what text, message text)
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NOT ok AND "public"."mantle_scope_active"()
     AND "public"."mantle_scoped_write_refuses"(what) THEN
    RAISE EXCEPTION '%', message USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_grant_refuses"(boolean, text, text) FROM PUBLIC;
--> statement-breakpoint

-- One grant row of `node` on `ws`, as the grants panel changes it:
--  add      a grant set on the item (Write `w`): a new row, or a row made a
--           hand row (no longer the folder's), not excluded. manage of the
--           home and a Moderator of `ws`.
--  exclude  "Removed here": the row excluded, Write off, a hand row. manage
--           of the home or a Moderator of `ws`.
--  hand     "Change here": the folder's row becomes a hand row. manage of
--           the home and a Moderator of `ws`.
--  write    the Write switch to `w`: the home row needs manage; on needs
--           manage and a Moderator of `ws`; off manage or a Moderator.
--  remove   the row deleted. manage of the home or a Moderator of `ws`.
--  restore  an excluded row deleted (the folder's grant reaches the item
--           again). manage of the home and a Moderator of `ws`.
-- add, exclude and hand stamp granted_by (the session's login, else
-- `actor`) and granted_at.
CREATE OR REPLACE FUNCTION "public"."mantle_grant_change"(
  op text, node uuid, ws uuid, w boolean, actor uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  home uuid;
  row_home boolean;
  manage boolean;
  moderates boolean;
  ok boolean;
  who uuid := coalesce("public"."mantle_login_id"(), actor);
BEGIN
  IF op IS NULL OR op NOT IN ('add', 'exclude', 'hand', 'write', 'remove', 'restore') THEN
    RAISE EXCEPTION 'mantle_grant_change: unknown op %', op USING ERRCODE = '22023';
  END IF;
  SELECT n."home_ws" INTO home FROM "public"."nodes" n
   WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501';
  END IF;
  SELECT g."is_home" INTO row_home FROM "public"."item_grants" g
   WHERE g."node_id" = node AND g."workspace_id" = ws;
  manage := "public"."mantle_may_manage_home"(home);
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
REVOKE ALL ON FUNCTION "public"."mantle_grant_change"(text, uuid, uuid, boolean, uuid) FROM PUBLIC;
--> statement-breakpoint

-- One item's home from its home to `to_ws` (plan 18.8): manage of the old
-- home and a Moderator of the new one. The new home's row becomes the home
-- (a folder's row stops being the folder's; an excluded one comes back with
-- Write off), stamped. The old home's row goes, or with `keep_old` stays
-- with Write off (a folder that still gives it brings it back as its row).
CREATE OR REPLACE FUNCTION "public"."mantle_grant_move_home"(
  node uuid, to_ws uuid, keep_old boolean, actor uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  from_ws uuid;
  who uuid := coalesce("public"."mantle_login_id"(), actor);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."nodes" n
                  WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"()) THEN
    RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501';
  END IF;
  SELECT g."workspace_id" INTO from_ws FROM "public"."item_grants" g
   WHERE g."node_id" = node AND g."is_home";
  PERFORM "public"."mantle_grant_refuses"("public"."mantle_may_manage_home"(from_ws),
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
REVOKE ALL ON FUNCTION "public"."mantle_grant_move_home"(uuid, uuid, boolean, uuid) FROM PUBLIC;
--> statement-breakpoint

-- A grant's audit row (grant.* only). The actor is the session's login when
-- one is set, else `actor`.
CREATE OR REPLACE FUNCTION "public"."mantle_workspace_event"(
  ws uuid, actor uuid, action text, subject jsonb)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  node uuid;
  subj jsonb := subject;
BEGIN
  IF action IS NULL OR action NOT LIKE 'grant.%' THEN
    RAISE EXCEPTION 'mantle_workspace_event: only grant.* actions' USING ERRCODE = '22023';
  END IF;
  -- Held to the scope (L5): a workspace of the scope, or the workspace of a
  -- grant on an item whose home the scope manages (a home's manager may
  -- remove or exclude a grant of a workspace it is not in).
  IF "public"."mantle_scope_active"() AND NOT coalesce(ws = ANY ("public"."mantle_scope_ws"()), false) THEN
    -- A subject sent as JSON text (postgres.js encodes a string parameter
    -- cast to jsonb as a JSON string): its object.
    IF jsonb_typeof(subj) = 'string' AND left(subj #>> '{}', 1) = '{' THEN
      subj := (subj #>> '{}')::jsonb;
    END IF;
    node := CASE WHEN jsonb_typeof(subj) = 'object' AND subj ->> 'node' ~ '^[0-9a-fA-F-]{36}$'
                 THEN (subj ->> 'node')::uuid END;
    PERFORM "public"."mantle_grant_refuses"(
      node IS NOT NULL AND coalesce((
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
--> statement-breakpoint

-- 5. The visibility confirm's workspace reads (see 5 above).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_nameable"(ws uuid)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT NOT "public"."mantle_scope_active"()
      OR ws = ANY ("public"."mantle_scope_ws"())
      OR "public"."mantle_scope_has_admin"()
      OR EXISTS (SELECT 1 FROM "public"."item_grants" g
                   JOIN "public"."nodes" n ON n."id" = g."node_id"
                  WHERE g."workspace_id" = ws AND NOT g."excluded"
                    AND n."read_ws" && "public"."mantle_scope_ws"())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_nameable"(uuid) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_folder_grant_rows"(folder uuid)
  RETURNS TABLE ("workspace_id" uuid, "write" boolean, "is_home" boolean, "excluded" boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT g."workspace_id", g."write", g."is_home", g."excluded"
    FROM "public"."item_grants" g
   WHERE g."node_id" = folder
     AND (NOT "public"."mantle_scope_active"() OR "public"."mantle_scope_has_admin"()
          OR EXISTS (SELECT 1 FROM "public"."nodes" f
                      WHERE f."id" = folder AND f."read_ws" && "public"."mantle_scope_ws"()))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_folder_grant_rows"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_folder_grant_rows"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_admin_id"(o uuid)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT w."id" FROM "public"."workspaces" w WHERE w."owner_id" = o AND w."is_admin" LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_admin_id"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_admin_id"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_live"(ws uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."id" = ws AND w."archived_at" IS NULL
                    AND "public"."mantle_ws_nameable"(w."id"))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_live"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_live"(uuid) TO "mantle_view_user";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_names"(ids uuid[])
  RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('wsId', w."id", 'name', w."name")
                            ORDER BY lower(w."name"), w."id"), '[]'::jsonb)
    FROM "public"."workspaces" w
   WHERE w."id" = ANY (ids) AND "public"."mantle_ws_nameable"(w."id")
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_names"(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_names"(uuid[]) TO "mantle_view_user";
