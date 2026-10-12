-- Workspaces arch A2b2a (plan v2 page fcc4aee4, section 20.1;
-- docs/actors.md, "The write role"): the row rules and the write checks of
-- the write role (mantle_write_user, no BYPASSRLS), and the trigger
-- functions its writes fire. No routing: no write runs on the role yet
-- (that is A2b2b), so nothing changes on a box.
--
-- The role itself is made by migrate before the migrations, by the same
-- code as the workspace role (viewer-roles.ts). Its table grants, its
-- function rights and the per-table rules below come from the access matrix
-- after the migrations (applyViewerGrants and syncWriteRoleRules,
-- access-matrix.ts), never from a list in this file.
--
-- 1. mantle_write_role_sync_table(t, write, check_args): one table's rules,
--    called per table in its own short transaction (lock_timeout 3 s, with
--    retries): a policy change takes the table's ACCESS EXCLUSIVE lock, and
--    one long transaction over every hot table would hold them all.
--     a. The write role reads what the workspace role reads: each policy
--        for mantle_view_user on t names mantle_write_user too.
--     b. A write table gets three permissive rules for the write role, each
--        the table's read rule: INSERT WITH CHECK, UPDATE USING and WITH
--        CHECK, DELETE USING. A row the scope cannot read matches no row,
--        and a write cannot move a row out of what the scope reads. Any
--        other write rule of the role on t is dropped.
--     c. The write check (mantle_write_check_trg) with the table's
--        arguments from the matrix, or none.
--    A table whose rules already match is left alone: no lock on a migrate
--    that changes nothing.
-- 2. mantle_write_check_trg: what the row rules do not decide. Reading an
--    item is not editing it. On the write role only (the trigger's WHEN:
--    current_user is the role, so a definer's own writes and the system
--    pool are never checked); a refusal follows mantle_scoped_write_refuses
--    (0277), so off, warn and on stage it as they stage the 0266 checks.
--     - 'self' (nodes): an INSERT needs a Moderator of the new item's home
--       (mantle_default_home, the function that sets it; a login's own
--       private workspace counts only when the scope's mantle.mod_ws holds
--       it), or the home is the home of
--       the item's folder and the scope may edit that folder (a create in a
--       folder; 0277 checks the folder edit too). An item with no home
--       needs an Admin scope. A session can name any workspace of the brain
--       as its create home (mantle.create_ws): this is what holds it to one
--       it moderates. An UPDATE needs edit of the item; a change of the
--       board rank alone (data.rank) needs edit of the item or of its
--       folder (plan 20.3); the kind of an item (type) never changes on the
--       role. A DELETE of an item with no home needs an Admin scope (0277
--       checks manage of a home).
--     - 'edit', column: a row of an item (a page, a chunk, a fact) needs
--       edit of that item, before and after. A row with no item (a fact
--       learned in chat) must stay inside the scope and be the caller's
--       own: its read_ws within the scope's workspaces, its login the
--       caller's (a fact of no item and no login is the system's: the
--       extractor writes those on the system pool).
--     - 'manage', column: a grant needs manage of the item's home (an Admin
--       scope for an item with no home); a new grant, one moved to another
--       workspace, or one made the home (is_home false to true) also needs
--       a Moderator of that workspace. via_folder_id is not the role's to
--       write (the matrix's `derived`): the folder rows are made by the
--       propagation triggers, which run as their owner.
-- 3. mantle_scoped_write_refuses (0277) reports a refusal on the write role
--    in off too, as in warn: no write runs on the role while the box is off
--    (the rollout switch: off is the system pool's path), so one that does
--    is stray and shows as a miss. Off and warn still let it run; on
--    refuses.
-- 4. The move check (0245, mantle_nodes_acl_path_trg) is staged the same
--    way: its three refusals go through mantle_scoped_write_refuses, so on
--    the write role off and warn report and on refuses, like the create and
--    delete checks. Every other session refuses as before.
-- 5. The two reap triggers become SECURITY DEFINER: a login deleting an
--    item must reap its facts and edges, also the ones its scope cannot
--    read. The guards (mantle_nodes_acl_guard_trg, mantle_follow_guard_trg,
--    mantle_nodes_login_guard_trg) keep the caller's rights on purpose:
--    they ask mantle_owner_role(), which reads current_user; as definers
--    they would always pass.
-- 6. No SECURITY DEFINER trigger function is open to PUBLIC (a trigger
--    needs no EXECUTE right to fire), and mantle_page_folder_id is open to
--    the workspace role (pages/read.ts calls it under that role) and so to
--    the write role, whose function rights mirror the workspace role's
--    (applyViewerGrants); never to PUBLIC.
--
-- Re-runnable.

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
  home uuid;
  target uuid;
BEGIN
  IF kind = 'self' THEN
    IF TG_OP = 'INSERT' THEN
      -- The home the item gets: nodes_acl_before_ins fires after this
      -- trigger (by name) and sets it from the same function, with the same
      -- settings, in the same statement.
      home := "public"."mantle_default_home"(NEW."owner_id", NEW."type", NEW."path");
      ok := CASE WHEN home IS NULL THEN "public"."mantle_scope_has_admin"()
                 ELSE "public"."mantle_may_manage"(home) END;
      IF NOT ok AND home IS NOT NULL THEN
        SELECT p."home_ws", p."write_ws" INTO f FROM "public"."nodes" p
         WHERE p."id" = "public"."mantle_parent_folder"(NEW."owner_id", NEW."type", NEW."path");
        ok := FOUND AND f."home_ws" = home
              AND coalesce("public"."mantle_may_edit"(f."home_ws", f."write_ws"), false);
      END IF;
      IF NOT ok AND "public"."mantle_scoped_write_refuses"('INSERT on nodes: no Moderator of the home') THEN
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
      IF OLD."home_ws" IS NULL AND NOT "public"."mantle_scope_has_admin"()
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
        ok := CASE WHEN n."home_ws" IS NULL THEN "public"."mantle_scope_has_admin"()
                   ELSE "public"."mantle_may_manage"(n."home_ws") END;
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
  -- Moderator of its workspace (plan v2: adding a grant needs a Moderator
  -- of the home and of the target; a home moves only to a workspace the
  -- caller moderates).
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

-- One table's rules for the write role. `write`: the table is a write
-- table. `check_args`: the write check's arguments, or NULL for none.
CREATE OR REPLACE FUNCTION "public"."mantle_write_role_sync_table"(
  t text, write boolean, check_args text[])
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  p record;
  rel regclass := to_regclass(t);
  rule text;
  n int;
  op text;
  pol text;
  want_qual text;
  want_check text;
  have text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mantle_write_user') THEN
    RAISE EXCEPTION 'mantle_write_role_sync_table: role mantle_write_user does not exist';
  END IF;
  IF rel IS NULL THEN
    RETURN; -- the table is gone since the caller listed it
  END IF;

  -- a. The read rules name the write role too. Only SELECT rules: a write
  --    rule of the workspace role would be a write right for both.
  FOR p IN SELECT pp.policyname, pp.roles, pp.cmd FROM pg_policies pp
            WHERE pp.schemaname || '.' || pp.tablename = t
              AND 'mantle_view_user' = ANY (pp.roles)
  LOOP
    IF p.cmd <> 'SELECT' THEN
      RAISE EXCEPTION 'mantle_write_role_sync_table: policy % on % for mantle_view_user is %, not SELECT',
        p.policyname, t, p.cmd;
    END IF;
    IF NOT 'mantle_write_user' = ANY (p.roles) THEN
      EXECUTE format('ALTER POLICY %I ON %s TO %s', p.policyname, rel,
        (SELECT string_agg(quote_ident(x), ', ') FROM unnest(p.roles || 'mantle_write_user'::name) x));
    END IF;
  END LOOP;

  -- b. The write rules: the table's one read rule, or none.
  IF write THEN
    SELECT count(*), max(pp.qual) INTO n, rule FROM pg_policies pp
     WHERE pp.schemaname || '.' || pp.tablename = t
       AND pp.cmd = 'SELECT' AND pp.permissive = 'PERMISSIVE'
       AND 'mantle_view_user' = ANY (pp.roles);
    IF n <> 1 OR rule IS NULL THEN
      RAISE EXCEPTION 'mantle_write_role_sync_table: % needs exactly one read rule for mantle_view_user, has %', t, n;
    END IF;
    FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      pol := split_part(t, '.', 2) || '_write_' || lower(op);
      want_qual := CASE WHEN op = 'INSERT' THEN NULL ELSE rule END;
      want_check := CASE WHEN op = 'DELETE' THEN NULL ELSE rule END;
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies pp
         WHERE pp.schemaname || '.' || pp.tablename = t AND pp.policyname = pol
           AND pp.cmd = op AND pp.permissive = 'PERMISSIVE'
           AND pp.roles = ARRAY['mantle_write_user']::name[]
           AND pp.qual IS NOT DISTINCT FROM want_qual
           AND pp.with_check IS NOT DISTINCT FROM want_check) THEN
        IF EXISTS (SELECT 1 FROM pg_policies pp
                    WHERE pp.schemaname || '.' || pp.tablename = t AND pp.policyname = pol) THEN
          EXECUTE format('DROP POLICY %I ON %s', pol, rel);
        END IF;
        EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR %s TO "mantle_write_user"%s%s',
          pol, rel, op,
          CASE WHEN want_qual IS NULL THEN '' ELSE ' USING (' || want_qual || ')' END,
          CASE WHEN want_check IS NULL THEN '' ELSE ' WITH CHECK (' || want_check || ')' END);
      END IF;
    END LOOP;
  END IF;
  FOR p IN SELECT pp.policyname FROM pg_policies pp
            WHERE pp.schemaname || '.' || pp.tablename = t
              AND 'mantle_write_user' = ANY (pp.roles) AND pp.cmd <> 'SELECT'
              AND NOT (write AND pp.policyname = pp.tablename || '_write_' || lower(pp.cmd)
                       AND pp.roles = ARRAY['mantle_write_user']::name[])
  LOOP
    EXECUTE format('DROP POLICY %I ON %s', p.policyname, rel);
  END LOOP;

  -- c. The write check.
  SELECT array_remove(string_to_array(encode(tg.tgargs, 'escape'), '\000'), '') INTO have
    FROM pg_trigger tg
   WHERE tg.tgrelid = rel AND tg.tgname = 'mantle_write_check'
     AND tg.tgfoid = 'public.mantle_write_check_trg()'::regprocedure;
  IF check_args IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = rel AND tg.tgname = 'mantle_write_check') THEN
      EXECUTE format('DROP TRIGGER mantle_write_check ON %s', rel);
    END IF;
  ELSIF have IS DISTINCT FROM check_args THEN
    IF EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = rel AND tg.tgname = 'mantle_write_check') THEN
      EXECUTE format('DROP TRIGGER mantle_write_check ON %s', rel);
    END IF;
    EXECUTE format('CREATE TRIGGER mantle_write_check BEFORE INSERT OR UPDATE OR DELETE ON %s '
                   'FOR EACH ROW WHEN (current_user = ''mantle_write_user'') '
                   'EXECUTE FUNCTION "public"."mantle_write_check_trg"(%s)',
      rel, (SELECT string_agg(quote_literal(a), ', ') FROM unnest(check_args) a));
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_write_role_sync_table"(text, boolean, text[]) FROM PUBLIC;
--> statement-breakpoint

-- 3. 0277's gate, with off reporting on the write role as warn does. The
--    rest is as in 0277: the system pool and every other session refuse.
CREATE OR REPLACE FUNCTION "public"."mantle_scoped_write_refuses"(what text)
  RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  mode text;
  writer boolean := session_user = 'mantle_write_user';
BEGIN
  -- The write role itself, or a login that may act as it (a per-database
  -- login: a direct membership with SET or INHERIT). Never pg_has_role: it
  -- says yes to a superuser for every role, and the system pool is one
  -- today. Never any membership row: from Postgres 16 a CREATEROLE role
  -- gets an ADMIN-only membership in each role it creates, and that one
  -- must not count (A2b1 audit, M1). Before 16 there is no such grant and
  -- no SET or INHERIT option: a direct membership counts.
  IF NOT writer THEN
    IF current_setting('server_version_num')::int >= 160000 THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM pg_auth_members m
                                JOIN pg_roles r ON r.oid = m.roleid
                                JOIN pg_roles u ON u.oid = m.member
                               WHERE r.rolname = ''mantle_write_user''
                                 AND u.rolname = session_user
                                 AND (m.set_option OR m.inherit_option))'
        INTO writer;
    ELSE
      SELECT EXISTS (SELECT 1 FROM pg_auth_members m
                       JOIN pg_roles r ON r.oid = m.roleid
                       JOIN pg_roles u ON u.oid = m.member
                      WHERE r.rolname = 'mantle_write_user' AND u.rolname = session_user)
        INTO writer;
    END IF;
  END IF;
  IF NOT writer THEN
    RETURN true;
  END IF;
  mode := "public"."mantle_actor_check_mode"();
  IF mode = 'on' THEN
    RETURN true;
  END IF;
  -- Warn, and off too (A2b2a fix round 2, L1): no write runs on the write
  -- role while the box is off, so one that does is stray; it runs, and the
  -- miss shows.
  RAISE NOTICE 'mantle actor miss: % (refused when the check is on)', left(what, 80);
  RETURN false;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_scoped_write_refuses"(text) FROM PUBLIC;
--> statement-breakpoint

-- 4. 0245's move check with its three refusals staged by the gate: on the
--    write role off and warn report the refusal and let the move run, on
--    refuses; every other session refuses as before (the gate answers true
--    for it). Everything else is as in 0245.
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
        IF "public"."mantle_scoped_write_refuses"('UPDATE on nodes: a move, no manage of the home') THEN
          RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501';
        END IF;
      END IF;
      IF m.folder IS NOT NULL AND NOT "public"."mantle_may_edit"(m.f_home, m.f_write) THEN
        IF "public"."mantle_scoped_write_refuses"('UPDATE on nodes: a move, no edit of the folder') THEN
          RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
        END IF;
      END IF;
      IF m."type" = 'app' AND m.folder IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(m.f_read) AS w
                      WHERE NOT (w = ANY (m."read_ws"))
                        AND NOT (w = ANY ("public"."mantle_scope_mod_ws"()))) THEN
        IF "public"."mantle_scoped_write_refuses"('UPDATE on nodes: an app placed, a workspace not moderated') THEN
          RAISE EXCEPTION 'placing this app adds a workspace you do not moderate' USING ERRCODE = '42501';
        END IF;
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
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_acl_path_trg"() FROM PUBLIC;
--> statement-breakpoint

-- 5. The reap triggers run as their owner (the migration's role).
ALTER FUNCTION "public"."reap_facts_for_node"() SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION "public"."reap_facts_for_node"() SET search_path = "public", pg_temp;
--> statement-breakpoint
ALTER FUNCTION "public"."reap_entity_edges_for_node"() SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION "public"."reap_entity_edges_for_node"() SET search_path = "public", pg_temp;
--> statement-breakpoint

-- 6. No definer trigger function open to PUBLIC; the folder-id helper to
--    the workspace role (and the write role, which mirrors its rights).
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
              AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_page_folder_id"(uuid, ltree, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_page_folder_id"(uuid, ltree, text) TO "mantle_view_user";
