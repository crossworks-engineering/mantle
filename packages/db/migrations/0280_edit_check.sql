-- Workspaces arch A3a (plan v2 page fcc4aee4, sections 5.1 to 5.3, 12 A3a,
-- 19 and 20.3; docs/edit-check.md): the database checks writes, behind a
-- new switch, mantle.edit_check (off, warn, on). Every refusal this file
-- adds goes through that switch: off is today's behaviour exactly, on every
-- box (every box starts off).
--
-- 1. One box-mode read for the check settings: mantle_check_box_mode(name)
--    and mantle_check_mode(name) (the box setting from the catalog, raised
--    by a session's own value, never lowered: the rule of
--    mantle.heads_check). mantle_actor_check_box_mode and
--    mantle_actor_check_mode now call them (same answers).
-- 2. The edit check's mode, its gate and its one refusal:
--    mantle_edit_check_mode(), mantle_edit_refuses(what) (warn: a NOTICE
--    "mantle actor miss: edit: ...", the app logs it as a miss; on: true;
--    off: false, nothing logged) and mantle_edit_refuse(what, detail,
--    message), which raises 42501 with the detail (no_read, no_edit,
--    read_only, ro_actor: plan 5.2, "the mapper reads the detail").
-- 3. One trigger switch: mantle_switch_triggers(names, enable, tries) takes
--    every lock first, in one LOCK TABLE ... NOWAIT, then enables or
--    disables the named triggers (0277's mantle_actor_check_triggers, made
--    general; that function now calls it). mantle_edit_check_triggers and
--    mantle_set_edit_check(mode) switch every edit check trigger
--    (mantle_edit_check, mantle_edit_check_<suffix>) with the box setting,
--    so off costs nothing: its triggers are disabled.
-- 4. The rule, written once (plan 5.1): the array forms
--    mantle_may_edit_in(ws, mod_ws, home, write_ws) and
--    mantle_may_manage_in(mod_ws, home); mantle_may_edit and
--    mantle_may_manage now call them with the scope. mantle_check_row(home,
--    write_ws, read_ws, need) and mantle_check_item(node, need) answer for
--    every table; the need is read, edit, manage, admin, appdata (an app's
--    data: edit, and while Informational is on an Admin scope too: owner
--    decision D6), link (a public link: edit, an app's: manage) or
--    link_close (a link closed: link, or an Admin user with the users
--    area).
-- 5. The read-only refusal (plan 4.1): a statement trigger on every item
--    table (the tables of mantle_actor_check_tables(), less node_acl_head:
--    a heads lock is not a change), WHEN
--    mantle.write_mode = 'ro': a read key, an assistant with no user, a
--    public link, a peer and a contact share without can_write write
--    nothing. Detail ro_actor.
-- 6. The heads locks filter by the scope (docs/actors.md, "A3a must"): on
--    the write role, mantle_lock_heads and mantle_lock_heads_more (and so
--    mantle_lock_heads_nested and mantle_lock_subtree_heads, which call
--    them) drop the ids the scope does not read, through the gate (warn
--    reports and locks them all).
--
-- The per-table checks of plan 5.2 (the triggers mantle_edit_check and
-- mantle_edit_check_<suffix>, on the write role, made by migrate from the
-- access matrix) and the derived keys are 0281. Re-runnable.

-- 1. The box-mode read.
CREATE OR REPLACE FUNCTION "public"."mantle_check_box_mode"(setting text)
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  box text;
BEGIN
  IF setting IS NULL OR setting NOT IN ('actor_check', 'edit_check') THEN
    RAISE EXCEPTION 'mantle_check_box_mode: actor_check or edit_check' USING ERRCODE = '22023';
  END IF;
  SELECT split_part(c, '=', 2) INTO box
    FROM pg_db_role_setting d, unnest(d.setconfig) AS c
   WHERE d.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND d.setrole = 0 AND c LIKE 'mantle.' || setting || '=%'
   LIMIT 1;
  RETURN CASE box WHEN 'warn' THEN 'warn' WHEN 'on' THEN 'on' ELSE 'off' END;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_check_mode"(setting text)
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  sess text := coalesce(nullif(current_setting('mantle.' || setting, true), ''), 'off');
  rank_box int;
  rank_sess int;
BEGIN
  rank_box := CASE "public"."mantle_check_box_mode"(setting) WHEN 'warn' THEN 1 WHEN 'on' THEN 2 ELSE 0 END;
  rank_sess := CASE sess WHEN 'warn' THEN 1 WHEN 'on' THEN 2 ELSE 0 END;
  RETURN CASE greatest(rank_box, rank_sess) WHEN 0 THEN 'off' WHEN 2 THEN 'on' ELSE 'warn' END;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_box_mode"()
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_check_box_mode"('actor_check')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_mode"()
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_check_mode"('actor_check')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_check_box_mode"(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_check_mode"(text) FROM PUBLIC;
--> statement-breakpoint

-- 2. The edit check's mode, gate and refusal.
CREATE OR REPLACE FUNCTION "public"."mantle_edit_check_mode"()
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_check_mode"('edit_check')
$$;
--> statement-breakpoint
-- Whether an A3a refusal stands. `what` names it for the warn NOTICE. The
-- mode is read only here, on the refusing path: an allowed write pays
-- nothing for it.
CREATE OR REPLACE FUNCTION "public"."mantle_edit_refuses"(what text)
  RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  mode text := "public"."mantle_edit_check_mode"();
BEGIN
  IF mode = 'on' THEN RETURN true; END IF;
  IF mode = 'warn' THEN
    RAISE NOTICE 'mantle actor miss: edit: % (refused when the edit check is on)', left(what, 100);
  END IF;
  RETURN false;
END
$$;
--> statement-breakpoint
-- The one way an A3a check refuses: through the gate, 42501 with the
-- detail the mapper reads.
CREATE OR REPLACE FUNCTION "public"."mantle_edit_refuse"(what text, detail text, message text)
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF "public"."mantle_edit_refuses"(what) THEN
    RAISE EXCEPTION '%', message USING ERRCODE = '42501', DETAIL = detail;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_check_mode"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_refuses"(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_refuse"(text, text, text) FROM PUBLIC;
--> statement-breakpoint

-- 3. The trigger switch. The triggers named `names` (not internal), with
--    their table and state.
CREATE OR REPLACE FUNCTION "public"."mantle_check_triggers_named"(names text[])
  RETURNS TABLE (tbl regclass, trigger_name name, enabled boolean) LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT g.tgrelid::regclass, g.tgname, g.tgenabled <> 'D'
    FROM pg_trigger g
   WHERE g.tgname = ANY (names) AND NOT g.tgisinternal
   ORDER BY g.tgrelid::regclass::text, g.tgname
$$;
--> statement-breakpoint
-- Enable or disable every trigger named `names` that is in the wrong state.
-- Each ALTER TABLE needs SHARE ROW EXCLUSIVE on its table, held to the
-- commit, so all those locks are taken first, in one LOCK TABLE with NOWAIT:
-- the call never waits on a table while it holds another. A busy table: wait
-- 200 ms and try all again, `tries` times, then fail (55P03) with nothing
-- changed. Returns how many triggers changed; none changed takes no lock.
CREATE OR REPLACE FUNCTION "public"."mantle_switch_triggers"(names text[], enable boolean, tries integer DEFAULT 5)
  RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  todo regclass[];
  t record;
  i integer := 0;
  n integer := 0;
BEGIN
  IF enable IS NULL OR names IS NULL THEN
    RAISE EXCEPTION 'mantle_switch_triggers: give the trigger names and true or false' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(DISTINCT c.tbl), '{}'::regclass[]) INTO todo
    FROM "public"."mantle_check_triggers_named"(names) c
   WHERE c.enabled <> enable;
  IF cardinality(todo) = 0 THEN
    RETURN 0;
  END IF;
  LOOP
    i := i + 1;
    BEGIN
      EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE NOWAIT',
                     (SELECT string_agg(x::text, ', ' ORDER BY x::text) FROM unnest(todo) AS x));
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF i >= greatest(coalesce(tries, 1), 1) THEN
        RAISE EXCEPTION 'mantle_switch_triggers: the item tables are busy (% tries); nothing changed, run it again when the box is quiet', i
          USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_sleep(0.2);
    END;
  END LOOP;
  FOR t IN SELECT c.tbl, c.trigger_name FROM "public"."mantle_check_triggers_named"(names) c
            WHERE c.enabled <> enable LOOP
    EXECUTE format('ALTER TABLE %s %s TRIGGER %I',
                   t.tbl, CASE WHEN enable THEN 'ENABLE' ELSE 'DISABLE' END, t.trigger_name);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;
--> statement-breakpoint
-- 0277's switch, now the general one (same answers: the count of tables,
-- one trigger each).
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_triggers"(enable boolean, tries integer DEFAULT 5)
  RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF enable IS NULL THEN
    RAISE EXCEPTION 'mantle_actor_check_triggers: give true or false' USING ERRCODE = '22023';
  END IF;
  RETURN "public"."mantle_switch_triggers"(ARRAY['mantle_actor_check'], enable, tries);
END
$$;
--> statement-breakpoint
-- The edit check's triggers: every trigger named mantle_edit_check or
-- mantle_edit_check_<suffix> (the per-table checks migrate makes from the
-- access matrix, on the write role) and mantle_edit_check_ro (the
-- read-only refusal). Derived from the triggers that exist, never a copied
-- list.
CREATE OR REPLACE FUNCTION "public"."mantle_edit_check_tables"()
  RETURNS TABLE (tbl regclass, trigger_name name, enabled boolean) LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT g.tgrelid::regclass, g.tgname, g.tgenabled <> 'D'
    FROM pg_trigger g
   WHERE (g.tgname = 'mantle_edit_check' OR g.tgname LIKE 'mantle\_edit\_check\_%')
     AND NOT g.tgisinternal
   ORDER BY g.tgrelid::regclass::text, g.tgname
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_edit_check_triggers"(enable boolean, tries integer DEFAULT 5)
  RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF enable IS NULL THEN
    RAISE EXCEPTION 'mantle_edit_check_triggers: give true or false' USING ERRCODE = '22023';
  END IF;
  RETURN "public"."mantle_switch_triggers"(
    ARRAY(SELECT DISTINCT e.trigger_name::text FROM "public"."mantle_edit_check_tables"() e),
    enable, tries);
END
$$;
--> statement-breakpoint
-- The one way to change the box's edit check mode (docs/update-prod.md): it
-- switches the triggers AND sets the database setting (a RESET for off), in
-- one transaction, as mantle_set_actor_check does. Run it as the superuser
-- that runs the migrations. The edit check refuses only what carries an
-- actor and a scope: on a box whose actor check is off it checks nothing.
CREATE OR REPLACE FUNCTION "public"."mantle_set_edit_check"(mode text)
  RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF mode IS NULL OR mode NOT IN ('off', 'warn', 'on') THEN
    RAISE EXCEPTION 'mantle_set_edit_check: mode must be off, warn or on' USING ERRCODE = '22023';
  END IF;
  PERFORM "public"."mantle_edit_check_triggers"(mode <> 'off');
  IF mode = 'off' THEN
    EXECUTE format('ALTER DATABASE %I RESET mantle.edit_check', current_database());
  ELSE
    EXECUTE format('ALTER DATABASE %I SET mantle.edit_check = %L', current_database(), mode);
  END IF;
  RETURN mode;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_check_triggers_named"(text[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_switch_triggers"(text[], boolean, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_actor_check_triggers"(boolean, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_check_triggers"(boolean, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_check_tables"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_set_edit_check"(text) FROM PUBLIC;
--> statement-breakpoint

-- 4. The rule, written once. The array forms are pure (no setting read), so
--    a preview can ask for any set of workspaces; the scope forms call them.
CREATE OR REPLACE FUNCTION "public"."mantle_may_edit_in"(ws uuid[], mod_ws uuid[], home uuid, write_ws uuid[])
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (home IS NOT NULL AND home = ANY (mod_ws)) OR coalesce(write_ws && ws, false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_may_manage_in"(mod_ws uuid[], home uuid)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT home IS NOT NULL AND home = ANY (mod_ws)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_may_edit"(home uuid, write_ws uuid[])
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT "public"."mantle_may_edit_in"("public"."mantle_scope_ws"(), "public"."mantle_scope_mod_ws"(), home, write_ws)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_may_manage"(home uuid)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT "public"."mantle_may_manage_in"("public"."mantle_scope_mod_ws"(), home)
$$;
--> statement-breakpoint
-- What the scope may do with an item of this home and these workspaces.
-- `kind` and `informational` matter only to link (an app's link needs
-- manage) and appdata (Informational: an Admin scope too, D6).
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
    WHEN 'link' THEN CASE WHEN kind = 'app' THEN "public"."mantle_may_manage_home"(home)
                          ELSE coalesce("public"."mantle_may_edit"(home, write_ws), false) END
    WHEN 'link_close' THEN (CASE WHEN kind = 'app' THEN "public"."mantle_may_manage_home"(home)
                                 ELSE coalesce("public"."mantle_may_edit"(home, write_ws), false) END)
                           OR "public"."mantle_scope_has_area"('users')
    ELSE NULL
  END;
END
$$;
--> statement-breakpoint
-- The same for an item by its id (read as the caller: inside a definer
-- trigger, every row). An item that is not there: NULL (the caller decides;
-- a foreign key refuses most such rows).
CREATE OR REPLACE FUNCTION "public"."mantle_check_item"(node uuid, need text)
  RETURNS boolean LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
DECLARE
  n record;
  ro boolean := false;
BEGIN
  IF need NOT IN ('read', 'edit', 'manage', 'admin', 'appdata', 'link', 'link_close') THEN
    RAISE EXCEPTION 'mantle_check_item: unknown need %', need USING ERRCODE = '22023';
  END IF;
  SELECT x."home_ws", x."write_ws", x."read_ws", x."type" INTO n FROM "public"."nodes" x WHERE x."id" = node;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF need = 'appdata' THEN
    SELECT a."data_read_only" INTO ro FROM "public"."apps" a WHERE a."node_id" = node;
  END IF;
  RETURN "public"."mantle_check_row"(n."home_ws", n."write_ws", n."read_ws", need, n."type", coalesce(ro, false));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_check_row"(uuid, uuid[], uuid[], text, "public"."node_type", boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_check_item"(uuid, text) FROM PUBLIC;
--> statement-breakpoint

-- 5. The read-only refusal: a statement on an item table while the
--    transaction's write mode is ro. Statement level: once per statement.
--    A cascade's inner statements are skipped (their source is checked).
CREATE OR REPLACE FUNCTION "public"."mantle_edit_ro_stmt"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  PERFORM "public"."mantle_edit_refuse"(
    format('%s on %s: a read-only actor (%s)', TG_OP, TG_TABLE_NAME,
           left(coalesce(current_setting('mantle.actor', true), ''), 40)),
    'ro_actor', 'not allowed to change anything: this caller only reads');
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_ro_stmt"() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  t regclass;
BEGIN
  -- Every item table but the heads rows: taking a heads lock (a definer's
  -- write of node_acl_head) is a lock, not a change of an item, and a read
  -- path takes one too.
  FOR t IN SELECT c.tbl FROM "public"."mantle_actor_check_tables"() c
            WHERE c.tbl <> 'public.node_acl_head'::regclass LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS mantle_edit_check_ro ON %s', t);
    EXECUTE format(
      'CREATE TRIGGER mantle_edit_check_ro BEFORE INSERT OR UPDATE OR DELETE ON %s '
      'FOR EACH STATEMENT WHEN (current_setting(''mantle.write_mode'', true) = ''ro'') '
      'EXECUTE FUNCTION "public"."mantle_edit_ro_stmt"()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 6. The heads locks filter by the scope. Whether the statement runs as the
--    write role: inside a definer current_user is the owner, so the session
--    (the role's own login) or the `role` setting (the per-database login's
--    default, SET LOCAL ROLE in the checked rerun) says who called.
CREATE OR REPLACE FUNCTION "public"."mantle_caller_is_write_role"()
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT session_user = 'mantle_write_user'
      OR coalesce(current_setting('role', true), '') = 'mantle_write_user'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_caller_is_write_role"() FROM PUBLIC;
--> statement-breakpoint
-- `ids` less those the scope does not read, for a write-role caller; every
-- id for any other. A dropped id is a refusal of the edit check: warn
-- reports it and keeps every id, on drops them. An id with no row is kept
-- (the lock takes nothing for it).
CREATE OR REPLACE FUNCTION "public"."mantle_heads_scope_filter"(ids uuid[])
  RETURNS uuid[] LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  dropped uuid[];
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 OR NOT "public"."mantle_caller_is_write_role"() THEN
    RETURN ids;
  END IF;
  SELECT coalesce(array_agg(n."id"), '{}'::uuid[]) INTO dropped
    FROM "public"."nodes" n
   WHERE n."id" = ANY (ids) AND NOT coalesce(n."read_ws" && "public"."mantle_scope_ws"(), false);
  IF cardinality(dropped) = 0 THEN
    RETURN ids;
  END IF;
  IF NOT "public"."mantle_edit_refuses"(format('heads lock: %s id(s) the scope does not read', cardinality(dropped))) THEN
    RETURN ids;
  END IF;
  RETURN ARRAY(SELECT u.x FROM unnest(ids) AS u(x) WHERE NOT (u.x = ANY (dropped)));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_heads_scope_filter"(uuid[]) FROM PUBLIC;
--> statement-breakpoint
-- mantle_lock_heads (0241) with the filter first; the rest as it was.
CREATE OR REPLACE FUNCTION "public"."mantle_lock_heads"(ids uuid[], lock_mode text)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF lock_mode NOT IN ('update', 'share') THEN
    RAISE EXCEPTION 'mantle_lock_heads: mode must be update or share, got %', lock_mode;
  END IF;
  IF coalesce(current_setting('mantle.heads_held', true), '') <> '' THEN
    RAISE EXCEPTION 'mantle_lock_heads: heads are already held in this transaction; use mantle_lock_heads_more'
      USING ERRCODE = '55000';
  END IF;
  ids := "public"."mantle_heads_scope_filter"(ids);
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    IF "public"."mantle_heads_check_mode"() = 'on' THEN
      RAISE EXCEPTION 'mantle_lock_heads: heads must be the first lock of the transaction'
        USING ERRCODE = '55000';
    END IF;
    PERFORM "public"."mantle_heads_miss"('lock_heads_first', NULL, 'transaction wrote or locked before taking heads');
  END IF;
  INSERT INTO "public"."node_acl_head" ("node_id")
    SELECT n."id" FROM "public"."nodes" n
     WHERE n."id" = ANY (ids)
       AND NOT EXISTS (SELECT 1 FROM "public"."node_acl_head" h WHERE h."node_id" = n."id")
    ON CONFLICT DO NOTHING;
  IF lock_mode = 'update' THEN
    PERFORM 1 FROM "public"."node_acl_head" h
      WHERE h."node_id" = ANY (ids) ORDER BY h."node_id" FOR UPDATE;
    PERFORM "public"."mantle_heads_set"(ids, ids);
  ELSE
    PERFORM 1 FROM "public"."node_acl_head" h
      WHERE h."node_id" = ANY (ids) ORDER BY h."node_id" FOR SHARE;
    PERFORM "public"."mantle_heads_set"(ids, '{}'::uuid[]);
  END IF;
END
$$;
--> statement-breakpoint
-- mantle_lock_heads_more (0277) with the filter first; the rest as it was.
CREATE OR REPLACE FUNCTION "public"."mantle_lock_heads_more"(ids uuid[])
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  held uuid[] := "public"."mantle_heads_held"();
  held_upd uuid[] := "public"."mantle_heads_held"(true);
  add uuid[];
BEGIN
  IF NOT "public"."mantle_heads_taken"() THEN
    RAISE EXCEPTION 'mantle_lock_heads_more: no heads held yet' USING ERRCODE = '55000';
  END IF;
  ids := "public"."mantle_heads_scope_filter"(ids);
  SELECT coalesce(array_agg(d.x ORDER BY d.x), '{}'::uuid[]) INTO add
    FROM (SELECT u.x FROM unnest(ids) AS u(x) WHERE u.x IS NOT NULL
          EXCEPT
          SELECT h.x FROM unnest(held_upd) AS h(x)) d;
  IF cardinality(add) = 0 THEN RETURN; END IF;
  INSERT INTO "public"."node_acl_head" ("node_id")
    SELECT n."id" FROM "public"."nodes" n
     WHERE n."id" = ANY (add)
       AND NOT EXISTS (SELECT 1 FROM "public"."node_acl_head" h WHERE h."node_id" = n."id")
    ON CONFLICT DO NOTHING;
  PERFORM 1 FROM "public"."node_acl_head" h
    WHERE h."node_id" = ANY (add) ORDER BY h."node_id" FOR UPDATE NOWAIT;
  PERFORM "public"."mantle_heads_set"(held || add, held_upd || add);
END
$$;
--> statement-breakpoint

-- The triggers follow the box mode: a fresh box is off, so every edit check
-- trigger is disabled (a write calls none).
DO $$ BEGIN
  PERFORM "public"."mantle_edit_check_triggers"("public"."mantle_check_box_mode"('edit_check') <> 'off', 50);
END $$;
