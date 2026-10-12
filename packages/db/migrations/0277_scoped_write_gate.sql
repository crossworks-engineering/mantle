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
BEGIN
  -- Direct membership only: pg_has_role says yes to a superuser for every
  -- role, and the system pool is one today.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = 'mantle_write_user'
       AND (r.rolname = session_user
            OR EXISTS (SELECT 1 FROM pg_auth_members m
                         JOIN pg_roles u ON u.oid = m.member
                        WHERE m.roleid = r.oid AND u.rolname = session_user))) THEN
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
-- the app logs later, as in 0275), on refuses it (42501). The fast path
-- stays: a statement with an actor, or a session whose mantle.actor_check
-- reads off, pays one setting read and no catalog read, so a box that is
-- off pays nothing more per write. A session that sets its own value to off
-- skips the check: the check finds code that forgot its actor, it is not a
-- credential (any role can set mantle.actor too; docs/actors.md).
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
  IF coalesce(current_setting('mantle.actor_check', true), '') NOT IN ('warn', 'on') THEN
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
