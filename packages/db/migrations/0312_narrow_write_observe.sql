-- Plan v3.2 S7a part a3: the narrow system role's write telemetry, REPORT
-- ONLY. A content write a narrow reason would lose on the narrow role is
-- counted, one release before the role is on by default (S7b), so every
-- box shows what the flip would refuse. Nothing is refused, no row
-- changes, and no model work can start (rule 8): the triggers raise a
-- NOTICE and the app's pool writes the miss row later, on another
-- connection, as the actor check's own misses (0275: an INSERT inside the
-- transaction would take a transaction id before mantle_lock_heads).
--
--  - narrow-content-write: the actor check trigger on a content table (the
--    tables mantle_actor_check covers) counts a write whose actor is a
--    narrow reason's (mantle_narrow_actor) AND current_user = session_user
--    AND mantle.route is not 'full'. current_user = session_user is the
--    full route: on the narrow route the write was refused before any
--    trigger (the role holds no content write), inside a definer
--    current_user is the definer's owner, and a foreign key's cascade runs
--    as the table's owner. mantle.route = 'full' marks a declared
--    full-route spot (viewer.ts FULL_ROUTE_SPOTS). Counted where the actor
--    check runs (warn or on): with it off the trigger is disabled and the
--    app sends no actor on the full route. Exact with the runtime role on
--    (every fleet box): as the superuser, a definer a migration made runs
--    as that same superuser, so its writes count too.
--  - narrow-cascade-delete: a delete from auth.users, spaces or agents by a
--    narrow reason's actor, not at a spot, counted once per statement at
--    the top (pg_trigger_depth() = 1), on either route: their foreign keys
--    cascade or set null into content tables as the owner, which the
--    narrow role's own rights never see.
--  - Not counted: a write whose actor a narrow exit rebound (a login, an
--    assistant, a full reason's asSystem, system work): it is that actor's
--    own work (viewer.ts systemRouteNow); a write by a definer; a cascade
--    from any other table.
--
-- Re-runnable. Revert: packages/db/rollback/0312_narrow_write_observe.revert.sql.

-- The triggers below take a lock on auth.users and agents: wait at most
-- 30 s for it, then fail the roll (a migration never queues the box
-- behind a long reader).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- The actors of the reasons routed narrow: viewer.ts AS_SYSTEM_ROUTE and
-- REQUEST_SYSTEM_ROUTE (the area exit binds system:http:admin-area, the
-- login-self exit system:http:login-self). narrow-observe.test.ts pins this
-- list equal to the maps, so a reason moved between routes needs a
-- migration that replaces this function. Open to every role (as PUBLIC's
-- functions are): it answers from its own list and reads nothing.
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_actor"(actor text)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp AS $$
  SELECT actor = ANY (ARRAY[
    'system:admin-area',
    'system:agent-workspace',
    'system:audit-log',
    'system:connector-binding',
    'system:connector-call',
    'system:heartbeat-own-row',
    'system:login-telegram',
    'system:pending-approval',
    'system:http:admin-area',
    'system:http:login-self'
  ]::text[])
$$;
--> statement-breakpoint

-- 0277's actor check, the narrow count added before its early return: a
-- statement with an actor still returns at once, a statement with none
-- still takes the miss path, unchanged.
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  seen_key text := 'mantle.actor_missed_' || TG_TABLE_NAME;
  narrow_key text := 'mantle.narrow_missed_' || TG_TABLE_NAME;
  who text := coalesce(current_setting('mantle.actor', true), '');
  mode text;
BEGIN
  IF who <> '' THEN
    IF who LIKE 'system:%' THEN
      IF "public"."mantle_narrow_actor"(who)
         AND current_user = session_user
         AND coalesce(current_setting('mantle.route', true), '') <> 'full'
         AND coalesce(current_setting(narrow_key, true), '') <> TG_OP THEN
        PERFORM set_config(narrow_key, TG_OP, true);
        RAISE NOTICE 'mantle narrow write: narrow-content-write % % %', who, TG_TABLE_NAME, TG_OP;
      END IF;
    END IF;
    RETURN NULL;
  END IF;
  IF pg_trigger_depth() > 1 THEN
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

-- The cascade count: after a delete from auth.users, spaces or agents, at
-- the top of the statement, by a narrow reason's actor not at a spot, when
-- it deleted a row. A trigger function needs no EXECUTE of the role that
-- fires it; mantle_narrow_actor is open to every role.
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_cascade_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  who text := coalesce(current_setting('mantle.actor', true), '');
BEGIN
  IF pg_trigger_depth() = 1 AND who LIKE 'system:%' THEN
    IF "public"."mantle_narrow_actor"(who)
       AND coalesce(current_setting('mantle.route', true), '') <> 'full'
       AND EXISTS (SELECT 1 FROM gone) THEN
      RAISE NOTICE 'mantle narrow write: narrow-cascade-delete % % DELETE', who, TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_cascade_stmt"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_cascade" AFTER DELETE ON "auth"."users"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_narrow_cascade_stmt"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "public"."spaces";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_cascade" AFTER DELETE ON "public"."spaces"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_narrow_cascade_stmt"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "public"."agents";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_cascade" AFTER DELETE ON "public"."agents"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_narrow_cascade_stmt"();
