-- Rollback of 0323_narrow_enable_off: what an operator runs BEFORE pinning
-- an image older than the one that added it, if they want its rules gone.
-- Not a migration: nothing runs it on its own.
--
-- 0323 refuses only the narrow system role a turn-on (and counts one by a
-- narrow reason off the narrow route); an older image's product turn-ons on
-- the narrow route would be refused, so a box that rolls back one image
-- with the narrow switch on runs this file first (with the switch off, the
-- default on production boxes, it needs none). Order when reverting
-- several: every newer one first (0326 down to 0324), then 0323, then 0322,
-- 0321, 0320, then 0319 down to 0314, each in its own transaction, newest
-- first.
--
-- It takes 'off:is_default' and 'off:backup_enabled' out of every
-- mantle_narrow_one_way trigger, and 'off:enabled' out of every one but
-- 0320's four (agents, tool_groups, channels, telegram_accounts); a trigger
-- left with no rule is dropped.
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0323_narrow_enable_off.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $do$
DECLARE
  r record;
  want text[];
BEGIN
  FOR r IN
    SELECT t.tgrelid AS rel, n.nspname::text AS sch, c.relname::text AS tbl,
           array_remove(string_to_array(encode(t.tgargs, 'escape'), '\000'), '') AS args,
           concat_ws(' OR ',
             CASE WHEN t.tgtype::int & 4 <> 0 THEN 'INSERT' END,
             CASE WHEN t.tgtype::int & 16 <> 0 THEN 'UPDATE' END,
             CASE WHEN t.tgtype::int & 8 <> 0 THEN 'DELETE' END) AS ev
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE t.tgname = 'mantle_narrow_one_way_trg'
  LOOP
    SELECT coalesce(array_agg(a ORDER BY o), '{}') INTO want
      FROM unnest(r.args) WITH ORDINALITY u(a, o)
     WHERE a NOT IN ('off:is_default', 'off:backup_enabled')
       AND (a <> 'off:enabled'
            OR (r.sch, r.tbl) IN (('public', 'agents'), ('public', 'tool_groups'),
                                  ('public', 'channels'), ('public', 'telegram_accounts')));
    IF want IS DISTINCT FROM r.args THEN
      EXECUTE format('DROP TRIGGER "mantle_narrow_one_way_trg" ON %I.%I', r.sch, r.tbl);
      IF cardinality(want) > 0 THEN
        EXECUTE format(
          'CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE %s ON %I.%I FOR EACH ROW '
          'EXECUTE FUNCTION "public"."mantle_narrow_one_way"(%s)',
          r.ev, r.sch, r.tbl,
          (SELECT string_agg(quote_literal(w), ', ' ORDER BY o) FROM unnest(want) WITH ORDINALITY u(w, o)));
      END IF;
    END IF;
  END LOOP;
END
$do$;
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0323 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198700000;
