-- Workspaces W5c: the switch budget counts the switch, not the work before it
-- (carried item from W5b2 fix round 2, L4).
--
-- 0261 set the 30 s deadline at the start of mantle_ws_migrate_locked, so
-- the 0251 pass inside mantle_ws_migrate (all the grant work of a fresh
-- brain) spent the budget meant for the DDL of the switch, and the error
-- then said the tables stayed busy when they had not. Now:
--
-- 1. mantle_ws_switch_budget() is the budget: 30 s, or what the setting
--    mantle.ws_switch_budget asks, from 1 second up to 1 hour (an operator
--    lengthens it for a manual run, a test shortens it). A value that is
--    not an interval falls back to 30 s.
-- 2. mantle_ws_migrate_locked sets no deadline. Its head wait takes at most
--    10 s, never more than the budget. It arms the budget
--    (mantle.ws_switch_armed) and runs mantle_ws_migrate as before.
-- 3. mantle_ws_switch_off starts the clock: when the budget is armed and no
--    deadline is set, the deadline is now plus the budget. The rest of its
--    body is 0261's.
-- 4. mantle_ws_ddl_retry words the deadline error as a time budget, and
--    under a budget only the deadline ends the retries (a budget longer
--    than 12 attempts, about 105 s, keeps retrying). The 12-attempt path
--    (no budget armed: a migration) is unchanged. The pause between tries
--    is at most 5 s; mantle.ws_ddl_retry_pause shortens it (tests), and
--    under a budget never below 1 s, so a long budget cannot fire lock
--    requests back to back for an hour.
--
-- The head wait is not in the budget: mantle_ws_migrate_locked locks the
-- head of every brain item first and waits at most 10 s for it (less when
-- the budget is shorter). So a boot switch holds at most about 10 s, plus
-- the 0251 grant pass, plus the budget.
--
-- mantle.ws_switch_budget and mantle.ws_ddl_retry_pause are conventions,
-- not permissions: any role may SET them in its own session. Only the
-- EXECUTE revoke on mantle_ws_migrate_locked limits who runs the switch.
-- Set them with SET in the session of a manual run (or a test), never with
-- ALTER DATABASE or ALTER ROLE ... SET: those apply at every boot and every
-- migration too.
--
-- Functions only: no row written, no LLM work, no extractor notify.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- The switch budget: 30 s unless mantle.ws_switch_budget asks for another
-- value, kept between 1 second and 1 hour. A bad value is 30 s.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_switch_budget"()
  RETURNS interval LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
DECLARE
  asked text := nullif(btrim(coalesce(current_setting('mantle.ws_switch_budget', true), '')), '');
  v interval;
BEGIN
  IF asked IS NULL THEN RETURN interval '30 seconds'; END IF;
  BEGIN
    v := asked::interval;
  EXCEPTION WHEN others THEN
    RETURN interval '30 seconds';
  END;
  IF v IS NULL THEN RETURN interval '30 seconds'; END IF;
  RETURN least(interval '1 hour', greatest(interval '1 second', v));
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_switch_budget"() FROM PUBLIC;
--> statement-breakpoint

-- DDL on busy tables, retried (L-db): every statement in one subtransaction
-- under the migration's 5 s lock_timeout; when a lock is busy the attempt
-- rolls back to its savepoint (releasing what it took), waits and tries
-- again, up to 12 times, then fails the migration (safe to run again).
-- Under a time budget (mantle.ws_switch_deadline, set by
-- mantle_ws_switch_off when mantle_ws_migrate_locked armed the budget)
-- each try waits at most 5 s and never past the deadline, and only the
-- deadline ends the retries (no attempt cap: a 10 minute budget gets its 10
-- minutes): 55P03, the whole transaction rolls back (no half switch) and
-- the next start tries again. The pause between tries grows to 5 s;
-- mantle.ws_ddl_retry_pause (seconds) caps it lower, never higher: a test
-- runs many tries in little time. Under a budget the pause is at least
-- 1 s whatever it says, so a budget of up to an hour makes at most about
-- one lock request a second, never a tight loop.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_ddl_retry"(stmts text[], what text)
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  attempt int := 0;
  st text;
  deadline timestamptz := nullif(current_setting('mantle.ws_switch_deadline', true), '')::timestamptz;
  armed text := nullif(current_setting('mantle.ws_switch_armed', true), '');
  budget_s bigint;
  left_s double precision;
  pause double precision := 5;
BEGIN
  BEGIN
    pause := least(5, greatest(0.01,
      coalesce(nullif(btrim(current_setting('mantle.ws_ddl_retry_pause', true)), '')::double precision, 5)));
  EXCEPTION WHEN others THEN
    pause := 5;
  END;
  IF deadline IS NOT NULL THEN
    pause := greatest(1, pause);
  END IF;
  LOOP
    attempt := attempt + 1;
    IF deadline IS NOT NULL THEN
      left_s := extract(epoch FROM deadline - clock_timestamp());
      IF left_s < 0.1 THEN
        budget_s := round(extract(epoch FROM coalesce(armed::interval, "public"."mantle_ws_switch_budget"())));
        RAISE EXCEPTION '%: the switch ran past its time budget (% s from the start of the switch); nothing changed, the next start tries again. A manual run may give more time: SET mantle.ws_switch_budget', what, budget_s
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM set_config('lock_timeout', greatest(1, least(5000, floor(left_s * 1000)))::bigint::text, true);
    END IF;
    BEGIN
      FOREACH st IN ARRAY stmts LOOP
        EXECUTE st;
      END LOOP;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF deadline IS NULL AND attempt >= 12 THEN
        RAISE EXCEPTION '%: the tables stayed busy for 12 attempts; run the migration again at a quieter time', what
          USING ERRCODE = 'lock_not_available';
      END IF;
      RAISE NOTICE '%: tables busy (attempt %), retrying', what, attempt;
      IF deadline IS NULL THEN
        PERFORM pg_sleep(least(attempt, pause));
      ELSE
        PERFORM pg_sleep(greatest(0, least(attempt, pause, extract(epoch FROM deadline - clock_timestamp()) - 0.1)));
      END IF;
    END;
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_ddl_retry"(text[], text) FROM PUBLIC;
--> statement-breakpoint

-- The switch (0261), its clock started here: when mantle_ws_migrate_locked
-- armed the budget and no deadline is set yet, the deadline is now plus the
-- budget. The work before (the head wait, the 0251 pass) does not spend it.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_switch_off"()
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  gone CONSTANT text[] := ARRAY[
    'nodes.nodes_zz_bridge_before', 'nodes.nodes_zz_bridge_ins', 'nodes.nodes_zz_bridge_upd',
    'nodes.nodes_zz_bridge_upd_stmt', 'apps.apps_zz_bridge', 'apps.apps_zz_bridge_ins',
    'tool_groups.tool_groups_zz_bridge', 'users.users_zz_bridge', 'nodes.nodes_inherit_before',
    'nodes.nodes_share_refresh_after', 'nodes.nodes_share_deleted_after',
    'nodes.nodes_embed_reach_after', 'node_embeds.node_embeds_added_after',
    'node_embeds.node_embeds_removed_after'];
  stmts text[] := '{}';
  t record;
  armed text := nullif(current_setting('mantle.ws_switch_armed', true), '');
BEGIN
  IF armed IS NOT NULL
     AND nullif(current_setting('mantle.ws_switch_deadline', true), '') IS NULL THEN
    PERFORM set_config('mantle.ws_switch_deadline', (clock_timestamp() + armed::interval)::text, true);
  END IF;
  INSERT INTO "public"."archive_node_levels"
         ("node_id", "owner_id", "audience", "share_level", "inherited_level", "embedded_level", "archived_at")
  SELECT n."id", n."owner_id", n."audience", n."share_level", n."inherited_level", n."embedded_level", now()
    FROM "public"."nodes" n
  ON CONFLICT ("node_id") DO NOTHING;
  -- Only the DDL still to do: a DROP TRIGGER IF EXISTS locks its table even
  -- when the trigger is gone, and a brain switched before (or a fresh one)
  -- must not wait on its writers for nothing.
  FOR t IN
    SELECT tg."tgname", ns."nspname", c."relname"
      FROM pg_trigger tg
      JOIN pg_class c ON c."oid" = tg."tgrelid"
      JOIN pg_namespace ns ON ns."oid" = c."relnamespace"
     WHERE NOT tg."tgisinternal" AND ns."nspname" IN ('public', 'auth')
       AND (c."relname" || '.' || tg."tgname") = ANY (gone)
  LOOP
    stmts := stmts || format('DROP TRIGGER IF EXISTS %I ON %I.%I', t."tgname", t."nspname", t."relname");
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg."tgname" = 'nodes_levels_frozen'
                    AND tg."tgrelid" = '"public"."nodes"'::regclass) THEN
    stmts := stmts || 'CREATE TRIGGER "nodes_levels_frozen"
       BEFORE UPDATE OF "audience", "share_level", "inherited_level", "embedded_level"
       ON "public"."nodes"
       FOR EACH ROW EXECUTE FUNCTION "public"."mantle_levels_frozen_trg"()'::text;
  END IF;
  IF cardinality(stmts) > 0 THEN
    PERFORM "public"."mantle_ws_ddl_retry"(stmts, 'the workspaces switch');
  END IF;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_switch_off"() FROM PUBLIC;
--> statement-breakpoint

-- The switch at boot (lib/workspaces-migrate.ts). It holds the head of
-- every brain item, so it must not wait long: the head wait takes at most
-- 10 s and never more than the budget (it is not counted in the budget),
-- and the budget (30 s unless mantle.ws_switch_budget asks for more or
-- less) starts at the switch itself (mantle_ws_switch_off), after the 0251
-- pass. The setting is a session SET for a manual run (any role may SET
-- it; the EXECUTE revoke below is what limits who runs this), never ALTER
-- DATABASE or ALTER ROLE ... SET, which would apply at boot too. On a timeout (55P03)
-- or a refused proof (23514) the whole transaction rolls back: the brain
-- stays on the old model, its integrity row ("workspaces: not migrated")
-- stays, and the next start tries again. A manual run on a big brain:
--   SET mantle.ws_switch_budget = '10 minutes';
--   SELECT * FROM mantle_ws_migrate_locked();
CREATE OR REPLACE FUNCTION "public"."mantle_ws_migrate_locked"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp
  SET lock_timeout = '10s'
  SET "mantle.ws_switch_deadline" = ''
  SET "mantle.ws_switch_armed" = '' AS $$
#variable_conflict use_column
DECLARE
  why text := "public"."mantle_ws_skip_reason"();
  budget interval := "public"."mantle_ws_switch_budget"();
BEGIN
  IF why IS NULL THEN
    RETURN QUERY SELECT 'skip'::text, 'workspaces'::text, 'already migrated'::text, 1::bigint;
    RETURN;
  END IF;
  IF why <> 'no workspaces yet' THEN
    RETURN QUERY SELECT 'skip'::text, why, 'count'::text, 1::bigint;
    RETURN;
  END IF;
  PERFORM set_config('lock_timeout',
    (least(10000, floor(extract(epoch FROM budget) * 1000)))::bigint::text, true);
  PERFORM set_config('mantle.ws_switch_armed', budget::text, true);
  PERFORM "public"."mantle_lock_heads"(ARRAY(
    SELECT x."id" FROM "public"."nodes" x WHERE x."owner_id" = "public"."mantle_brain_id"()), 'update');
  PERFORM pg_advisory_xact_lock(hashtext('mantle_ws_migrate'));
  RETURN QUERY SELECT * FROM "public"."mantle_ws_migrate"();
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate_locked"() FROM PUBLIC;
