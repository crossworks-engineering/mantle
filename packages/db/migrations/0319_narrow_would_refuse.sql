-- Plan v3.2 S7b part b2 round 9 (the CEO's decision C of round 8): the
-- narrow system role's would-refuse count, REPORT ONLY. The switch stays
-- off in production (S7b part b3 flips it after the fleet's counts read 0);
-- until then every box counts each write a narrow reason makes on the full
-- route that the narrow role would refuse once the switch is on:
--
--  - narrow-would-refuse, privilege: an INSERT or DELETE on a table where
--    the narrow role holds neither, or an UPDATE that names a column it
--    may not update (an INSERT ... ON CONFLICT DO UPDATE needs UPDATE on
--    every column its SET names, a conflict or not; Postgres checks a
--    statement's privileges before any row). The function is here; its
--    triggers are DERIVED from the narrow role's live grants on every
--    migrate (runtime-role.ts applyNarrowWouldRefuse, after the grants):
--    statement-level AFTER INSERT, AFTER DELETE and AFTER UPDATE OF the
--    columns it lacks, so a write the role may make fires nothing and a
--    hot table's allowed writes pay nothing. Not on the content tables:
--    0312's narrow-content-write counts those (the actor check's trigger).
--  - narrow-would-refuse, 0318's one-way rules: mantle_narrow_one_way
--    takes a report branch: the same rule broken by a narrow reason's
--    actor off the narrow route is counted and the row is written.
--
-- Counted when the actor is a narrow reason's (0312's mantle_narrow_actor),
-- current_user = session_user (the full route: on the narrow route the
-- role refuses the write itself, counted as narrow-denied; inside a
-- definer or a foreign key's cascade current_user is the owner) and
-- mantle.route is not 'full' (a declared spot). Once per table and
-- operation per transaction. A NOTICE: the app's pool writes the miss row
-- on another connection (actor.ts onPgNotice), so nothing changes in the
-- write's own transaction. Not counted: a systemDb write inside a login's
-- turn or request scope (its actor is the login's; the narrow route takes
-- it with the switch on whatever the actor): the suites with the switch on
-- measure those (round 9 handover).
--
-- Re-runnable. Revert: packages/db/rollback/0319_narrow_would_refuse.revert.sql.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_narrow_would_refuse_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  who text := coalesce(current_setting('mantle.actor', true), '');
  seen_key text := 'mantle.narrow_would_' || TG_TABLE_SCHEMA || '_' || TG_TABLE_NAME;
BEGIN
  IF who LIKE 'system:%' AND "public"."mantle_narrow_actor"(who)
     AND current_user = session_user
     AND coalesce(current_setting('mantle.route', true), '') <> 'full'
     AND position(TG_OP IN coalesce(current_setting(seen_key, true), '')) = 0 THEN
    PERFORM set_config(seen_key, coalesce(current_setting(seen_key, true), '') || TG_OP || ' ', true);
    RAISE NOTICE 'mantle narrow write: narrow-would-refuse % %.% %', who, TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_would_refuse_stmt"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_one_way"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  who text := coalesce(current_setting('mantle.actor', true), '');
  report boolean := false;
  o jsonb;
  n jsonb;
  arg text;
  col text;
  i int;
BEGIN
  IF current_user <> 'mantle_system_narrow' THEN
    -- Report only (0319): the same row change by a narrow reason's actor
    -- off the narrow route (the switch off), not at a spot, is counted as
    -- one the narrow role would refuse, and runs.
    IF who LIKE 'system:%' AND "public"."mantle_narrow_actor"(who)
       AND current_user = session_user
       AND coalesce(current_setting('mantle.route', true), '') <> 'full' THEN
      report := true;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  BEGIN
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
  EXCEPTION WHEN insufficient_privilege THEN
    IF NOT report THEN
      RAISE;
    END IF;
    RAISE NOTICE 'mantle narrow write: narrow-would-refuse % %.% UPDATE', who, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_one_way"() FROM PUBLIC;
