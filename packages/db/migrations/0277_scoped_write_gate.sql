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
-- Last in this file: the 0275 statement check now refuses a write with no
-- actor when the check is on. Re-runnable.

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
-- item table with no mantle.actor: off runs it, warn reports it (a NOTICE
-- the app logs later, as in 0275), on refuses it (42501). A statement with
-- an actor pays one setting read. One with no actor reads the box mode from
-- the catalog first (mantle_actor_check_mode: a session may only make it
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
