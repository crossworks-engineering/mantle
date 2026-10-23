-- Rollback of 0329_narrow_counter_enabled: what an operator runs BEFORE
-- reverting 0328 (or pinning an image older than the one that added it).
-- Not a migration: nothing runs it on its own.
--
-- It puts 0328's mantle_narrow_counter_missing() back (a trigger counts as
-- there when not disabled). An older image never calls the function, so
-- it runs with 0329 in place; the revert is for 0328's, which must follow
-- it. Order when reverting several: 0329 first, then 0328 down to 0315,
-- each in its own transaction, newest first.
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0329_narrow_counter_enabled.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_counter_missing"()
  RETURNS bigint LANGUAGE sql STABLE
  SET search_path = "pg_catalog", pg_temp AS $$
  -- The derived triggers the grants call for
  -- (mantle_narrow_would_refuse_expected) less the ones there: a trigger
  -- of that name, not disabled, calling the count's function and, for the
  -- UPDATE OF one, naming exactly its columns. 0 when the counter is
  -- whole. NULL with no narrow role or before 0320.
  SELECT CASE WHEN to_regprocedure('public.mantle_narrow_would_refuse_stmt()') IS NULL
                OR to_regrole('mantle_system_narrow') IS NULL THEN NULL ELSE
    (SELECT count(*) FROM "public"."mantle_narrow_would_refuse_expected"() e
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger g
         WHERE g.tgrelid = e.rel AND g.tgname = e.trigger_name AND NOT g.tgisinternal
           AND g.tgenabled <> 'D'
           AND g.tgfoid = to_regprocedure('public.mantle_narrow_would_refuse_stmt()')
           AND (e.trigger_name <> 'mantle_narrow_would_refuse_upd'
                OR (SELECT array_agg(x ORDER BY x) FROM unnest(g.tgattr::int2[]) x) = e.cols)))
  END
$$;
REVOKE ALL ON FUNCTION "public"."mantle_narrow_counter_missing"() FROM PUBLIC;
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790199820000;
