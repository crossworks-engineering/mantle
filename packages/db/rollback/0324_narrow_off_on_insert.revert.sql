-- Rollback of 0324_narrow_off_on_insert: what an operator runs BEFORE
-- pinning an image older than the one that added it, if they want its rule
-- gone. Not a migration: nothing runs it on its own.
--
-- 0324 refuses only the narrow system role an INSERT that names a switch
-- on (and counts one by a narrow reason off the narrow route). Order when
-- reverting several: 0325 first, then 0324, 0323, 0322, 0321, 0320, then
-- 0319 down to 0314, each in its own transaction, newest first.
--
-- It takes INSERT out of every mantle_narrow_one_way_trg trigger (none
-- fired on INSERT before 0324) and reverses 0324's two replaces in
-- mantle_narrow_one_way.
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0324_narrow_off_on_insert.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname::text AS sch, c.relname::text AS tbl,
           array_remove(string_to_array(encode(t.tgargs, 'escape'), '\000'), '') AS args,
           concat_ws(' OR ',
             CASE WHEN t.tgtype::int & 16 <> 0 THEN 'UPDATE' END,
             CASE WHEN t.tgtype::int & 8 <> 0 THEN 'DELETE' END) AS ev
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE t.tgname = 'mantle_narrow_one_way_trg' AND t.tgtype::int & 4 <> 0
  LOOP
    EXECUTE format('DROP TRIGGER "mantle_narrow_one_way_trg" ON %I.%I', r.sch, r.tbl);
    EXECUTE format(
      'CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE %s ON %I.%I FOR EACH ROW '
      'EXECUTE FUNCTION "public"."mantle_narrow_one_way"(%s)',
      r.ev, r.sch, r.tbl,
      (SELECT string_agg(quote_literal(w), ', ' ORDER BY o) FROM unnest(r.args) WITH ORDINALITY u(w, o)));
  END LOOP;
END
$do$;
--> statement-breakpoint
DO $do$
DECLARE
  def text;
BEGIN
  def := pg_catalog.pg_get_functiondef('"public"."mantle_narrow_one_way"()'::regprocedure);
  def := replace(def,
    E'  IF TG_OP IN (''UPDATE'', ''INSERT'') THEN\n    n := to_jsonb(NEW);\n  END IF;',
    E'  IF TG_OP = ''UPDATE'' THEN\n    n := to_jsonb(NEW);\n  END IF;');
  def := replace(def,
    E'      IF TG_OP = ''INSERT'' AND kind <> ''off'' THEN\n        CONTINUE;\n      ELSIF kind = ''keepif'' THEN\n        CONTINUE;\n',
    E'      IF kind = ''keepif'' THEN\n        CONTINUE;\n');
  EXECUTE def;
END
$do$;
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0324 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198800000;
