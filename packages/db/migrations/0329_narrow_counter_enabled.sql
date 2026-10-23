-- The would-refuse counter's missing triggers (0328's
-- mantle_narrow_counter_missing) count a derived trigger as there only when
-- it fires on a box: enabled in origin mode or always (tgenabled O or A).
-- 0328 read "not disabled", so a trigger set to fire in replica mode only
-- (R, which never fires with session_replication_role origin, a box's
-- setting) counted as there while it counted nothing. Migrate's trigger
-- step (runtime-role.ts applyNarrowWouldRefuse) reads the same rule and
-- makes such a trigger again; the box script (scripts/arch-scoreboard-box.sh)
-- reads this function. No EXECUTE for PUBLIC, as 0328's.
--
-- Revert: packages/db/rollback/0329_narrow_counter_enabled.revert.sql
-- (0329 first, before 0328).
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_counter_missing"()
  RETURNS bigint LANGUAGE sql STABLE
  SET search_path = "pg_catalog", pg_temp AS $$
  -- The derived triggers the grants call for
  -- (mantle_narrow_would_refuse_expected) less the ones there: a trigger
  -- of that name, enabled (origin or always), calling the count's function
  -- and, for the UPDATE OF one, naming exactly its columns. 0 when the
  -- counter is whole. NULL with no narrow role or before 0320.
  SELECT CASE WHEN to_regprocedure('public.mantle_narrow_would_refuse_stmt()') IS NULL
                OR to_regrole('mantle_system_narrow') IS NULL THEN NULL ELSE
    (SELECT count(*) FROM "public"."mantle_narrow_would_refuse_expected"() e
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger g
         WHERE g.tgrelid = e.rel AND g.tgname = e.trigger_name AND NOT g.tgisinternal
           AND g.tgenabled IN ('O', 'A')
           AND g.tgfoid = to_regprocedure('public.mantle_narrow_would_refuse_stmt()')
           AND (e.trigger_name <> 'mantle_narrow_would_refuse_upd'
                OR (SELECT array_agg(x ORDER BY x) FROM unnest(g.tgattr::int2[]) x) = e.cols)))
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_counter_missing"() FROM PUBLIC;
