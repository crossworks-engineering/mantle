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
--  - narrow-would-refuse, 0319's one-way rules: mantle_narrow_one_way
--    takes a report branch: the same rule broken by a narrow reason's
--    actor off the narrow route is counted and the row is written.
--
-- Counted when the actor is a narrow reason's (0312's mantle_narrow_actor),
-- current_user is the session's own role (the role it SET, else its login,
-- as 0318's counts ask: the full route; on the narrow route the role
-- refuses the write itself, counted as narrow-denied; inside a definer or
-- a foreign key's cascade current_user is the owner, so a definer's own
-- writes on a superuser's pool are not counted) and
-- mantle.route is not 'full' (a declared spot). Once per table and
-- operation per transaction. A NOTICE: the app's pool writes the miss row
-- on another connection (actor.ts onPgNotice), so nothing changes in the
-- write's own transaction.
--
-- Also counted, whatever the actor (round 10, the CEO's decision: the
-- count is the only evidence for the flip, so it has no blind spot): a
-- statement whose settings mark mantle.route = 'narrow', which the app
-- sends on a systemDb write inside a login's turn or request scope with
-- the switch off (gateway/pools.ts getScopeMarkedDb): the narrow route
-- takes those with the switch on whatever the actor, and their actor is
-- the login's, which no narrow reason names. mantle_narrow_counted says
-- both; 0312's content and cascade counts (0318's bodies) take it too.
-- Every report branch asks one predicate, mantle_narrow_report(who): the
-- count, the session's own role, not at a spot, and a role that may not
-- run what it reads answers false (never a refusal).
--
-- Re-runnable. Revert: packages/db/rollback/0320_narrow_would_refuse.revert.sql.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_narrow_counted"(who text)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp AS $$
  SELECT (who LIKE 'system:%' AND "public"."mantle_narrow_actor"(who))
      OR coalesce(current_setting('mantle.route', true), '') = 'narrow'
$$;
--> statement-breakpoint
-- The one report predicate: every report branch asks it. A write by a
-- narrow reason's actor, or on a statement marked mantle.route = 'narrow'
-- (mantle_narrow_counted), made by the session's own role (the role it SET,
-- else its login: inside a definer or a foreign key's cascade current_user
-- is the owner, not counted), not at a declared spot (mantle.route =
-- 'full'). `held` and `id` name a hold to test as well (0327 gives them
-- their meaning; here a hold is never named). A role that may not run a
-- function the test reads answers false: the write runs uncounted and is
-- never refused for it (0327's held readers: an older image's migrate
-- grants the runtime role its own list, without them). The first test is
-- the cheap half of mantle_narrow_counted (a system actor or the narrow
-- mark) and runs before the guard: a login's write with no narrow mark
-- pays no subtransaction; any system actor's write, a full-route one too,
-- enters the guard. Open to every role, as PUBLIC's functions are: it
-- reads the session's own settings and asks readers that check their own
-- EXECUTE.
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_report"(who text, held text DEFAULT NULL, id uuid DEFAULT NULL)
  RETURNS boolean LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
DECLARE
  -- The session's own role: the role it SET, else its login. A definer
  -- changes current_user, never this (a variable: plpgsql ends an IF's
  -- test at its first THEN, a CASE's included).
  own_role text := CASE WHEN current_setting('role') = 'none' THEN session_user::text
                        ELSE current_setting('role') END;
BEGIN
  IF coalesce(who, '') NOT LIKE 'system:%'
     AND coalesce(current_setting('mantle.route', true), '') <> 'narrow' THEN
    RETURN false;
  END IF;
  BEGIN
    IF NOT ("public"."mantle_narrow_counted"(coalesce(who, ''))
            AND current_user::text = own_role
            AND coalesce(current_setting('mantle.route', true), '') <> 'full') THEN
      RETURN false;
    END IF;
    IF held IS NULL THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'mantle_narrow_report: unknown hold %', held USING ERRCODE = '22023';
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN false;
  END;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_would_refuse_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  who text := coalesce(current_setting('mantle.actor', true), '');
  seen_key text := 'mantle.narrow_would_' || TG_TABLE_SCHEMA || '_' || TG_TABLE_NAME;
BEGIN
  IF "public"."mantle_narrow_report"(who)
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
    -- Report only (0320): the same row change by a narrow reason's actor
    -- (or on a statement marked mantle.route = 'narrow')
    -- off the narrow route (the switch off), not at a spot, is counted as
    -- one the narrow role would refuse, and runs.
    IF "public"."mantle_narrow_report"(who) THEN
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
--> statement-breakpoint
-- 0318's content and cascade counts, the mark taken too (mantle_narrow_counted);
-- otherwise 0318's bodies.
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
    IF who LIKE 'system:%' OR coalesce(current_setting('mantle.route', true), '') = 'narrow' THEN
      IF "public"."mantle_narrow_report"(who)
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
  IF pg_trigger_depth() = 1 AND who <> '' THEN
    IF "public"."mantle_narrow_report"(who)
       AND EXISTS (SELECT 1 FROM gone) THEN
      RAISE NOTICE 'mantle narrow write: narrow-cascade-delete % % DELETE', who, TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_cascade_stmt"() FROM PUBLIC;
