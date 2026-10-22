-- Rollback of 0319_narrow_would_refuse: what an operator runs BEFORE
-- pinning an image older than the one that added it, if they want the
-- count gone. Not a migration: nothing runs it on its own.
--
-- 0319 adds a report-only trigger function (its triggers are derived on
-- every migrate by runtime-role.ts applyNarrowWouldRefuse), gives 0318's
-- mantle_narrow_one_way a report branch, and lets 0317's content and
-- cascade counts take the route mark (mantle_narrow_counted). An older image runs with
-- both in place (they only raise a NOTICE it prints): a rollback of one
-- image needs NOT this file. This file drops the derived triggers and the
-- function, puts 0318's and 0317's functions back and takes 0319 off the ledger, so a
-- later roll forward applies it again (it is re-runnable).
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0319_narrow_would_refuse.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.tgname, t.tgrelid::regclass AS rel FROM pg_trigger t
            WHERE t.tgname IN ('mantle_narrow_would_refuse_ins', 'mantle_narrow_would_refuse_del',
                               'mantle_narrow_would_refuse_upd') AND NOT t.tgisinternal LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', r.tgname, r.rel);
  END LOOP;
END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_would_refuse_stmt"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_one_way"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  o jsonb;
  n jsonb;
  arg text;
  col text;
  i int;
BEGIN
  IF current_user <> 'mantle_system_narrow' THEN
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    arg := TG_ARGV[i];
    col := split_part(arg, ':', 2);
    IF split_part(arg, ':', 1) = 'clear' THEN
      IF (o ->> col) IS NOT NULL AND (n ->> col) IS NULL THEN
        RAISE EXCEPTION 'the narrow system role may not clear %.%', TG_TABLE_NAME, col
          USING ERRCODE = '42501';
      END IF;
    ELSIF split_part(arg, ':', 1) = 'up' THEN
      IF (n ->> col)::numeric < (o ->> col)::numeric THEN
        RAISE EXCEPTION 'the narrow system role may not lower %.%', TG_TABLE_NAME, col
          USING ERRCODE = '42501';
      END IF;
    ELSIF split_part(arg, ':', 1) = 'drop' THEN
      IF (o -> col) IS DISTINCT FROM (n -> col) AND (n ->> col) IS NOT NULL THEN
        RAISE EXCEPTION 'the narrow system role may only clear %.%', TG_TABLE_NAME, col
          USING ERRCODE = '42501';
      END IF;
    ELSIF split_part(arg, ':', 1) = 'from' THEN
      IF (o -> col) IS DISTINCT FROM (n -> col)
         AND (n -> col) IS DISTINCT FROM (o -> split_part(arg, ':', 3)) THEN
        RAISE EXCEPTION 'the narrow system role may set %.% only from %', TG_TABLE_NAME, col,
          split_part(arg, ':', 3) USING ERRCODE = '42501';
      END IF;
    ELSIF split_part(arg, ':', 1) = 'keep' THEN
      IF (o -> col -> split_part(arg, ':', 3)) IS DISTINCT FROM (n -> col -> split_part(arg, ':', 3)) THEN
        RAISE EXCEPTION 'the narrow system role may not change %.% %', TG_TABLE_NAME, col,
          split_part(arg, ':', 3) USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'mantle_narrow_one_way: unknown rule %', arg USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_one_way"() FROM PUBLIC;
--> statement-breakpoint
-- 0317's content and cascade counts, as 0317 made them (no route mark).
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
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_counted"(text);
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE created_at = 1790198460000;
