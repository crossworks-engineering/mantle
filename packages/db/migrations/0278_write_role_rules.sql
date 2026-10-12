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
--     - 'self' (nodes): an UPDATE needs edit of the item; a change of the
--       board rank alone (data.rank) needs edit of the item or of its
--       folder (plan 20.3). A DELETE of an item with no home needs an
--       Admin scope (0277 checks manage of a home).
--     - 'edit', column: a row of an item (a page, a chunk, a fact) needs
--       edit of that item, before and after. A row with no item (a fact
--       learned in chat) must stay inside the scope: its read_ws within
--       the scope's workspaces, its login none or the caller's own.
--     - 'manage', column: a grant needs manage of the item's home (an Admin
--       scope for an item with no home); a new grant, or one moved to
--       another workspace, also needs a Moderator of that workspace.
-- 3. The two reap triggers become SECURITY DEFINER: a login deleting an
--    item must reap its facts and edges, also the ones its scope cannot
--    read. The guards (mantle_nodes_acl_guard_trg, mantle_follow_guard_trg,
--    mantle_nodes_login_guard_trg) keep the caller's rights on purpose:
--    they ask mantle_owner_role(), which reads current_user; as definers
--    they would always pass.
-- 4. No SECURITY DEFINER trigger function is open to PUBLIC (a trigger
--    needs no EXECUTE right to fire), and mantle_page_folder_id is open to
--    the workspace role only (pages/read.ts calls it under that role).
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
BEGIN
  IF kind = 'self' THEN
    IF TG_OP = 'UPDATE' THEN
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
      -- A row of no item: inside the scope, and nobody else's.
      IF kind = 'manage' OR NOT (r ? 'read_ws') THEN
        ok := false;
      ELSE
        ws := ARRAY(SELECT jsonb_array_elements_text(r -> 'read_ws'))::uuid[];
        ok := ws <@ "public"."mantle_scope_ws"()
              AND (r ->> 'login_id' IS NULL OR (r ->> 'login_id')::uuid = "public"."mantle_login_id"());
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

  -- A new grant, or one moved to another workspace: a Moderator of it.
  IF kind = 'manage' AND TG_OP IN ('INSERT', 'UPDATE') THEN
    IF (TG_OP = 'INSERT' OR (to_jsonb(NEW) ->> 'workspace_id') IS DISTINCT FROM (to_jsonb(OLD) ->> 'workspace_id'))
       AND NOT ((to_jsonb(NEW) ->> 'workspace_id')::uuid = ANY ("public"."mantle_scope_mod_ws"()))
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

-- 3. The reap triggers run as their owner (the migration's role).
ALTER FUNCTION "public"."reap_facts_for_node"() SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION "public"."reap_facts_for_node"() SET search_path = "public", pg_temp;
--> statement-breakpoint
ALTER FUNCTION "public"."reap_entity_edges_for_node"() SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION "public"."reap_entity_edges_for_node"() SET search_path = "public", pg_temp;
--> statement-breakpoint

-- 4. No definer trigger function open to PUBLIC; the folder-id helper to
--    the workspace role only.
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
