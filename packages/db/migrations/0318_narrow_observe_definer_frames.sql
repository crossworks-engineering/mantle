-- The narrow write telemetry (0312) counts what the session itself writes,
-- never a definer's work (plan v3.2 S7b part b2). 0312 told a write on the
-- full route by current_user = session_user; on the per-database fallback
-- the narrow route takes the narrow role per transaction on the system
-- pool, whose login is the superuser, so inside a superuser-owned definer
-- current_user is that superuser again and the definer's own content write
-- (mantle_structure_item, the 0317 definers) counted as a
-- narrow-content-write, and a definer's delete of an agent as a
-- narrow-cascade-delete, though the narrow role wrote nothing.
--
-- Both counts now ask that current_user be the session's own role: the
-- role it SET (current_setting('role')), else its login (session_user). A
-- SECURITY DEFINER frame changes current_user and never the role setting,
-- so a definer's writes are left out on every route: the narrow login
-- (current_user the definer's owner, the role setting none, session_user
-- the narrow role), the per-database fallback (the role setting the narrow
-- role) and the full route with the runtime role on (the owner is not the
-- runtime role). On the full route with the system pool logged in as the
-- superuser that owns the definers the two stay one role, as 0312 says.
-- Everything else is 0312's: the actor, the route mark, once per
-- statement and table.
--
-- Re-runnable. No table or row changes; no LLM work. Revert:
-- packages/db/rollback/0318_narrow_observe_definer_frames.revert.sql (puts
-- 0312's bodies back). The `when` sits 60000 above 0317's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  seen_key text := 'mantle.actor_missed_' || TG_TABLE_NAME;
  narrow_key text := 'mantle.narrow_missed_' || TG_TABLE_NAME;
  who text := coalesce(current_setting('mantle.actor', true), '');
  -- The session's own role: the role it SET, else its login. A definer
  -- changes current_user, never this (a variable: plpgsql ends an IF's
  -- test at its first THEN, a CASE's included).
  own_role text := CASE WHEN current_setting('role') = 'none' THEN session_user::text
                        ELSE current_setting('role') END;
  mode text;
BEGIN
  IF who <> '' THEN
    IF who LIKE 'system:%' THEN
      IF "public"."mantle_narrow_actor"(who)
         AND current_user::text = own_role
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
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_cascade_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  who text := coalesce(current_setting('mantle.actor', true), '');
  -- The session's own role: the role it SET, else its login. A definer
  -- changes current_user, never this (a variable: plpgsql ends an IF's
  -- test at its first THEN, a CASE's included).
  own_role text := CASE WHEN current_setting('role') = 'none' THEN session_user::text
                        ELSE current_setting('role') END;
BEGIN
  IF pg_trigger_depth() = 1 AND who LIKE 'system:%' THEN
    IF "public"."mantle_narrow_actor"(who)
       AND current_user::text = own_role
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
