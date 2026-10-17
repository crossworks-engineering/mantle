-- Plan v3.2 step S3 (docs/actors.md, "Plan v3 S3"): the write role always,
-- the two gap tables closed. The check mode decides refuse or report, never
-- the pool: a login's scoped write runs on the write role in every mode, and
-- profiles and app_table_exports become ordinary write-role tables, so the
-- gap rerun (the system pool, or the checked rerun as mantle_gap_writer) is
-- gone from client.ts. No row is touched; no app, app row, app database or
-- sandbox is removed. Grants come from the access matrix after the
-- migrations (applyViewerGrants), never from this file.
--
-- The number was claimed at the merge (plan v3.2 rule 3): R0 landed first
-- with 0301_check_mode_floor (`when` 1790197380000); this file is 0302
-- with the `when` it had as 0301 (1790197440000, above R0's).
--
-- 1. app_table_exports: row level security, and one read rule for the
--    workspace role: the rows of an app the scope manages (a Moderator of
--    its home; an app with no home, an Admin scope), the same test as the
--    write check `manage` (mantle_write_check_trg, 0278) the matrix gives
--    it. The write role reads and writes by the same rule (the sync below
--    names it on the read rule and makes the write rules from it), so an
--    UPDATE with a WHERE or a RETURNING finds the row it may change and no
--    other. The system pool and the runtime role pass row level security
--    (owner, BYPASSRLS): the export sync and the dirty stamp (the named
--    system step) run as before.
-- 2. profiles is a content table now (the matrix's writer), so it gets the
--    actor check's statement trigger (0275's mantle_actor_check, pinned by
--    actor-trigger-coverage.db.test.ts), disabled when the box's check is
--    off, as mantle_set_actor_check keeps every one of them. That makes it
--    an item table (mantle_actor_check_tables), so it gets the edit check's
--    two item triggers too, with 0294's bodies, made here on profiles alone
--    (0294's loop would lock every item table while profiles is held): the
--    read-only refusal (a read-only session writes no profile row) and the
--    contact share's (a contact share writes its app's data only), switched
--    by the edit check's mode.
-- 3. mantle_write_role_sync_table(t, write, check_args, write_rule): 0278's
--    sync with a write rule narrower than the read rule. NULL: the write
--    rules are the table's read rule, as before. 'own-login' (profiles,
--    owner decision 2026-10-17): the login's own row, or the brain's row
--    when the scope's login holds the Settings area
--    (mantle_scope_has_area: the Admin workspace in the scope, the area not
--    limited off). Never another login's row, so a member's turn
--    (set_timezone, the reminder channel, the automatic time zone) cannot
--    change the brain's row, and neither can an Admin user without the
--    Settings area. A delete is the login's own row only (no code deletes
--    a profile; the brain's row is never deleted through a scope). A rule
--    given here is matched by the note on its policies (COMMENT ON POLICY,
--    with a version: a changed rule bumps it), not by its text: Postgres
--    stores the expression in its own form.
--    The 0278 signature stays as a thin call with no write rule: the image
--    before S3 calls it on a rollback (rule 2), and its matrix lists
--    profiles as no write table, so its sync drops these write rules.
--
-- Re-runnable.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- Both altered tables locked first, in one statement (as 0283).
LOCK TABLE "public"."app_table_exports", "public"."profiles" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."app_table_exports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "app_table_exports_user_read" ON "public"."app_table_exports";
--> statement-breakpoint
CREATE POLICY "app_table_exports_user_read" ON "public"."app_table_exports" FOR SELECT
  TO mantle_view_user
  USING (EXISTS (
    SELECT 1 FROM "public"."nodes" a
     WHERE a."id" = "app_table_exports"."app_node_id"
       AND CASE WHEN a."home_ws" IS NULL THEN "public"."mantle_scope_has_admin"()
                ELSE coalesce("public"."mantle_may_manage"(a."home_ws"), false) END));
--> statement-breakpoint

DROP TRIGGER IF EXISTS "mantle_actor_check" ON "public"."profiles";
--> statement-breakpoint
CREATE TRIGGER "mantle_actor_check" BEFORE INSERT OR UPDATE OR DELETE ON "public"."profiles"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_actor_check_stmt"();
--> statement-breakpoint
DO $$ BEGIN
  IF "public"."mantle_actor_check_box_mode"() = 'off' THEN
    ALTER TABLE "public"."profiles" DISABLE TRIGGER "mantle_actor_check";
  END IF;
END $$;
--> statement-breakpoint
-- The edit check's two item triggers on the new item table, with 0294's
-- bodies, on profiles only: 0294's loop (mantle_edit_check_item_triggers)
-- would reach every item table, each under its own lock, with profiles
-- held. Off by the edit check's box mode, as the loop leaves them.
CREATE OR REPLACE TRIGGER "mantle_edit_check_ro" BEFORE INSERT OR UPDATE OR DELETE ON "public"."profiles"
  FOR EACH STATEMENT WHEN (current_setting('mantle.write_mode', true) = 'ro')
  EXECUTE FUNCTION "public"."mantle_edit_ro_stmt"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "mantle_edit_check_contact" BEFORE INSERT OR UPDATE OR DELETE ON "public"."profiles"
  FOR EACH STATEMENT WHEN (current_setting('mantle.actor', true) = 'contact:rw')
  EXECUTE FUNCTION "public"."mantle_edit_contact_stmt"();
--> statement-breakpoint
DO $$ BEGIN
  IF "public"."mantle_check_box_mode"('edit_check') = 'off' THEN
    ALTER TABLE "public"."profiles" DISABLE TRIGGER "mantle_edit_check_ro";
    ALTER TABLE "public"."profiles" DISABLE TRIGGER "mantle_edit_check_contact";
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_write_role_sync_table"(
  t text, write boolean, check_args text[], write_rule text)
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  p record;
  rel regclass := to_regclass(t);
  rule text;
  del_rule text;
  note text;
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

  -- b. The write rules: the table's one read rule, or the named write rule.
  IF write THEN
    SELECT count(*), max(pp.qual) INTO n, rule FROM pg_policies pp
     WHERE pp.schemaname || '.' || pp.tablename = t
       AND pp.cmd = 'SELECT' AND pp.permissive = 'PERMISSIVE'
       AND 'mantle_view_user' = ANY (pp.roles);
    IF n <> 1 OR rule IS NULL THEN
      RAISE EXCEPTION 'mantle_write_role_sync_table: % needs exactly one read rule for mantle_view_user, has %', t, n;
    END IF;
    IF write_rule IS NULL THEN
      note := NULL;
      del_rule := rule;
    ELSIF write_rule = 'own-login' THEN
      rule := '("user_id" = (SELECT "public"."mantle_login_id"())) OR '
           || '(("user_id" = (SELECT "public"."mantle_brain_id"())) '
           || 'AND (SELECT "public"."mantle_scope_has_area"(''settings'')))';
      del_rule := '("user_id" = (SELECT "public"."mantle_login_id"()))';
      -- The version in the note: a changed rule gets a new note, so a rerun
      -- replaces the policies (matched by note, not by text).
      note := 'mantle:write-rule:own-login:v1';
    ELSE
      RAISE EXCEPTION 'mantle_write_role_sync_table: unknown write rule %', write_rule;
    END IF;
    FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      pol := split_part(t, '.', 2) || '_write_' || lower(op);
      want_qual := CASE op WHEN 'INSERT' THEN NULL WHEN 'DELETE' THEN del_rule ELSE rule END;
      want_check := CASE WHEN op = 'DELETE' THEN NULL ELSE rule END;
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies pp
          JOIN pg_policy pl ON pl.polrelid = rel AND pl.polname = pp.policyname
         WHERE pp.schemaname || '.' || pp.tablename = t AND pp.policyname = pol
           AND pp.cmd = op AND pp.permissive = 'PERMISSIVE'
           AND pp.roles = ARRAY['mantle_write_user']::name[]
           AND obj_description(pl.oid, 'pg_policy') IS NOT DISTINCT FROM note
           AND CASE WHEN note IS NULL
                    THEN pp.qual IS NOT DISTINCT FROM want_qual
                         AND pp.with_check IS NOT DISTINCT FROM want_check
                    ELSE (pp.qual IS NULL) = (want_qual IS NULL)
                         AND (pp.with_check IS NULL) = (want_check IS NULL) END) THEN
        IF EXISTS (SELECT 1 FROM pg_policies pp
                    WHERE pp.schemaname || '.' || pp.tablename = t AND pp.policyname = pol) THEN
          EXECUTE format('DROP POLICY %I ON %s', pol, rel);
        END IF;
        EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE FOR %s TO "mantle_write_user"%s%s',
          pol, rel, op,
          CASE WHEN want_qual IS NULL THEN '' ELSE ' USING (' || want_qual || ')' END,
          CASE WHEN want_check IS NULL THEN '' ELSE ' WITH CHECK (' || want_check || ')' END);
        IF note IS NOT NULL THEN
          EXECUTE format('COMMENT ON POLICY %I ON %s IS %L', pol, rel, note);
        END IF;
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
REVOKE ALL ON FUNCTION "public"."mantle_write_role_sync_table"(text, boolean, text[], text) FROM PUBLIC;
--> statement-breakpoint

-- 0278's signature: no write rule (the image before S3 calls it).
CREATE OR REPLACE FUNCTION "public"."mantle_write_role_sync_table"(
  t text, write boolean, check_args text[])
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
BEGIN
  PERFORM "public"."mantle_write_role_sync_table"(t, write, check_args, NULL::text);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_write_role_sync_table"(text, boolean, text[]) FROM PUBLIC;
