-- Rollback of 0318_narrow_observe_definer_frames: what an operator runs
-- BEFORE pinning an image older than the one that added it, if they want
-- 0312's counts back. Not a migration: nothing runs it on its own.
--
-- 0318 replaces the bodies of the two telemetry trigger functions (a
-- definer's work no longer counts). An older image runs with either body:
-- a rollback of one image needs NOT this file. This file puts 0312's
-- bodies back and takes 0318 off the ledger, so a later roll forward
-- applies it again (it is re-runnable).
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0318_narrow_observe_definer_frames.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
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
-- Off the ledger: the next roll forward applies 0318 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790199160000;
