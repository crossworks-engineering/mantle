-- Workspaces arch A2b (plan v2 page fcc4aee4, sections 5.3 and 20.1): the
-- 0266 create and delete checks wait for mantle.actor_check before they
-- refuse a login's scoped write.
--
-- Today only an Admin user's write request (and an Admin turn) sets its
-- scope on the system pool's transactions, so only those writes meet the
-- 0266 checks. A2b2 scopes every login write, on the write role
-- (mantle_write_user, no BYPASSRLS). On that role a refusal now follows the
-- check's mode, in the same three steps as the actor check:
--
--  - off: the write runs, as it does today for a member's write;
--  - warn: the write runs and a NOTICE "mantle actor miss: ..." reports the
--    refusal it would be (the app logs it as a miss, capped);
--  - on: refused, 42501, as today on the system pool.
--
-- Every other session (the system pool, an operator) refuses as before.
-- The gate keys on the session's ROLE, never on a mantle.* setting: any
-- role can set those (docs/actors.md, "The settings are not a credential").
-- The mode is mantle_actor_check_mode(): the box setting, which a session
-- can only raise. The gate runs only on the refusing path, so an allowed
-- write pays nothing for it.
--
-- Then: the 0275 statement check now refuses a write with no actor when the
-- check is on, and its triggers follow the box mode: disabled when the box
-- is off, so a write there calls no trigger at all (A2b1 fix round 2, M1;
-- the owner's scaling rule). mantle_set_actor_check(mode) is the one way to
-- change the mode. Last: the heads functions this file adds are not open to
-- PUBLIC (fix round 2, M2). Re-runnable.

-- Whether a refusal of the 0266 checks stands for this session. `what`
-- names it for the warn NOTICE.
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
  IF mode = 'warn' THEN
    RAISE NOTICE 'mantle actor miss: % (refused when the check is on)', left(what, 80);
  END IF;
  RETURN false;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_scoped_write_refuses"(text) FROM PUBLIC;
--> statement-breakpoint

-- 0266 4a, gated: a new item in a folder needs edit of the folder.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_scope_create_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  f record;
BEGIN
  IF pg_trigger_depth() > 1 OR NOT "public"."mantle_scope_active"() THEN
    RETURN NEW;
  END IF;
  SELECT n."id", n."home_ws", n."write_ws" INTO f
    FROM "public"."nodes" n
   WHERE n."id" = "public"."mantle_parent_folder"(NEW."owner_id", NEW."type", NEW."path");
  IF FOUND AND NOT coalesce("public"."mantle_may_edit"(f."home_ws", f."write_ws"), false)
     AND "public"."mantle_scoped_write_refuses"('INSERT on nodes: no edit of the folder') THEN
    RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_scope_create_trg"() FROM PUBLIC;
--> statement-breakpoint

-- 0266 4b, gated: deleting an item needs manage of its home.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_scope_delete_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR NOT "public"."mantle_scope_active"() THEN
    RETURN OLD;
  END IF;
  IF OLD."home_ws" IS NOT NULL AND NOT "public"."mantle_may_manage"(OLD."home_ws")
     AND "public"."mantle_scoped_write_refuses"('DELETE on nodes: no manage of the home') THEN
    RAISE EXCEPTION 'not allowed to delete this item' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_scope_delete_trg"() FROM PUBLIC;
--> statement-breakpoint

-- The SQL actor check refuses in 'on' (A2b; A2a only logged). A write on an
-- item table with no mantle.actor: warn reports it (a NOTICE the app logs
-- later, as in 0275), on refuses it (42501). The trigger is enabled only
-- while the box is warn or on (mantle_set_actor_check, below), so it never
-- runs on a box that is off. A statement with an actor pays one setting
-- read. One with no actor (the miss path) reads the box mode from the
-- catalog first (mantle_actor_check_mode: a session may only make it
-- stricter), so a session that sets its own value to off cannot skip the
-- refusal (A2b1 audit, L4). Statement level: once per statement, not per
-- row.
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  seen_key text := 'mantle.actor_missed_' || TG_TABLE_NAME;
  mode text;
BEGIN
  IF coalesce(current_setting('mantle.actor', true), '') <> '' OR pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  mode := "public"."mantle_actor_check_mode"();
  IF mode = 'off' THEN RETURN NULL; END IF;
  IF mode = 'on' THEN
    RAISE EXCEPTION 'mantle actor check: % on % with no actor', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '42501', DETAIL = 'no_actor';
  END IF;
  IF coalesce(current_setting(seen_key, true), '') = TG_OP THEN RETURN NULL; END IF;
  PERFORM set_config(seen_key, TG_OP, true);
  RAISE NOTICE 'mantle actor miss: % on %', TG_OP, TG_TABLE_NAME;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- The box's own mode (the catalog only, no session value): off, warn or on.
-- mantle_actor_check_mode reads it, then lets a session raise it.
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_box_mode"()
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  box text;
BEGIN
  SELECT split_part(c, '=', 2) INTO box
    FROM pg_db_role_setting d, unnest(d.setconfig) AS c
   WHERE d.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND d.setrole = 0 AND c LIKE 'mantle.actor_check=%'
   LIMIT 1;
  RETURN CASE box WHEN 'warn' THEN 'warn' WHEN 'on' THEN 'on' ELSE 'off' END;
END
$$;
--> statement-breakpoint

-- 0275's mode, now on the one catalog read above. Same answer.
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_mode"()
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  sess text := coalesce(nullif(current_setting('mantle.actor_check', true), ''), 'off');
  rank_box int;
  rank_sess int;
BEGIN
  rank_box := CASE "public"."mantle_actor_check_box_mode"() WHEN 'warn' THEN 1 WHEN 'on' THEN 2 ELSE 0 END;
  rank_sess := CASE sess WHEN 'warn' THEN 1 WHEN 'on' THEN 2 ELSE 0 END;
  RETURN CASE greatest(rank_box, rank_sess) WHEN 0 THEN 'off' WHEN 2 THEN 'on' ELSE 'warn' END;
END
$$;
--> statement-breakpoint

-- The tables that carry the actor check, and whether each trigger is
-- enabled. Derived from the triggers that exist, never a copied list: a
-- later migration that adds the trigger to a table is in it at once.
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_tables"()
  RETURNS TABLE (tbl regclass, enabled boolean) LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT g.tgrelid::regclass, g.tgenabled <> 'D'
    FROM pg_trigger g
   WHERE g.tgname = 'mantle_actor_check' AND NOT g.tgisinternal
   ORDER BY g.tgrelid::regclass::text
$$;
--> statement-breakpoint

-- Enable or disable every mantle_actor_check trigger. Only the ones in the
-- wrong state change, so a call that changes nothing takes no lock. Returns
-- how many changed. Each ALTER TABLE needs SHARE ROW EXCLUSIVE on its table,
-- held to the commit. So all those locks are taken first, in one LOCK TABLE
-- with NOWAIT: the call never waits on a table while it holds another (no
-- stall per table, no deadlock with a writer). A busy table: wait 200 ms and
-- try all again, `tries` times, then fail (55P03) with nothing changed. While
-- the locks are held, new writes on those tables queue for the few
-- milliseconds the ALTERs take. Called by mantle_set_actor_check, by this
-- migration, and by a migration that adds the trigger to a new table.
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_triggers"(enable boolean, tries integer DEFAULT 5)
  RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  todo regclass[];
  t regclass;
  i integer := 0;
BEGIN
  IF enable IS NULL THEN
    RAISE EXCEPTION 'mantle_actor_check_triggers: give true or false' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(c.tbl ORDER BY c.tbl::text), '{}'::regclass[]) INTO todo
    FROM "public"."mantle_actor_check_tables"() c
   WHERE c.enabled <> enable;
  IF cardinality(todo) = 0 THEN
    RETURN 0;
  END IF;
  LOOP
    i := i + 1;
    BEGIN
      EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE NOWAIT',
                     (SELECT string_agg(x::text, ', ') FROM unnest(todo) AS x));
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF i >= greatest(coalesce(tries, 1), 1) THEN
        RAISE EXCEPTION 'mantle_actor_check_triggers: the item tables are busy (% tries); nothing changed, run it again when the box is quiet', i
          USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_sleep(0.2);
    END;
  END LOOP;
  FOREACH t IN ARRAY todo LOOP
    EXECUTE format('ALTER TABLE %s %s TRIGGER mantle_actor_check',
                   t, CASE WHEN enable THEN 'ENABLE' ELSE 'DISABLE' END);
  END LOOP;
  RETURN cardinality(todo);
END
$$;
--> statement-breakpoint

-- The one way to change the box's actor check mode (docs/update-prod.md): it
-- switches the triggers (mantle_actor_check_triggers: all locks at once, no
-- wait, up to 5 tries; a busy box fails with nothing changed) AND sets the
-- database setting (a RESET for off), in one transaction. Off: the triggers
-- are disabled, a write calls none. Warn or on: enabled. Setting a custom
-- parameter with ALTER DATABASE needs a superuser (or GRANT SET ON
-- PARAMETER): run it as the superuser that runs the migrations. The app
-- processes read the mode at start and each minute; restart them to apply
-- it at once.
CREATE OR REPLACE FUNCTION "public"."mantle_set_actor_check"(mode text)
  RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF mode IS NULL OR mode NOT IN ('off', 'warn', 'on') THEN
    RAISE EXCEPTION 'mantle_set_actor_check: mode must be off, warn or on' USING ERRCODE = '22023';
  END IF;
  PERFORM "public"."mantle_actor_check_triggers"(mode <> 'off');
  IF mode = 'off' THEN
    EXECUTE format('ALTER DATABASE %I RESET mantle.actor_check', current_database());
  ELSE
    EXECUTE format('ALTER DATABASE %I SET mantle.actor_check = %L', current_database(), mode);
  END IF;
  RETURN mode;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_actor_check_box_mode"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_actor_check_tables"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_actor_check_triggers"(boolean, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_set_actor_check"(text) FROM PUBLIC;
--> statement-breakpoint

-- The triggers follow the box mode now: disabled on a box that is off (a
-- fresh install, every box but dev), enabled on one that is warn or on.
-- Up to 50 tries (about 10 s) here: a migration on a busy box waits a
-- little longer than an operator's call.
DO $$ BEGIN
  PERFORM "public"."mantle_actor_check_triggers"("public"."mantle_actor_check_box_mode"() <> 'off', 50);
END $$;
--> statement-breakpoint

-- Heads taken: the transaction called mantle_lock_heads (its first lock),
-- even for no rows. The signed settings say so; mantle_heads_held() alone
-- cannot tell "taken for none" from "never taken".
CREATE OR REPLACE FUNCTION "public"."mantle_heads_taken"()
  RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  held text := coalesce(current_setting('mantle.heads_held', true), '');
BEGIN
  RETURN held <> '' AND coalesce(current_setting('mantle.heads_sig', true), '')
           = "public"."mantle_heads_sig"(held, coalesce(current_setting('mantle.heads_held_upd', true), ''));
END
$$;
--> statement-breakpoint

-- mantle_lock_heads_more (0241) with one change (A2b1 fix round): a
-- transaction that took its heads first for no rows may take more. Before,
-- it was refused as "no heads held yet", and a first lock was refused too
-- (the empty lock had already started the transaction id), so it could take
-- no heads at all.
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

-- A heads lock nested in a transaction that may hold heads already (A2b,
-- plan 20.2; A2b1 audit L2): the database decides, not a flag in the app.
-- Heads taken (even for no rows): take more (mantle_lock_heads_more, FOR
-- UPDATE NOWAIT). None taken: this is the transaction's first lock, with
-- every rule of mantle_lock_heads (first lock, heads check). Open to the
-- same roles as mantle_lock_heads.
CREATE OR REPLACE FUNCTION "public"."mantle_lock_heads_nested"(ids uuid[], lock_mode text)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF "public"."mantle_heads_taken"() THEN
    PERFORM "public"."mantle_lock_heads_more"(ids);
  ELSE
    PERFORM "public"."mantle_lock_heads"(ids, lock_mode);
  END IF;
END
$$;
--> statement-breakpoint

-- Heads functions are for the migrating role and the definer functions only
-- (0241's rule): no limited role takes heads or signs a held list (A2b1 fix
-- round 2, M2). The two this file adds were open to PUBLIC. The three
-- signers were closed by 0241; closed again here so the rule holds even if
-- one is dropped and made again. The pin: actor-trigger-coverage.db.test.ts.
REVOKE ALL ON FUNCTION "public"."mantle_heads_taken"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_lock_heads_nested"(uuid[], text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_heads_set"(uuid[], uuid[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_heads_sig"(text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_heads_mac"(text) FROM PUBLIC;
