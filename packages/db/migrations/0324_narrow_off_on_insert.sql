-- The enable class on INSERT (the narrow login part b2: the
-- re-audit's DB LOW-1). 0323 held every enabled, is_default and
-- backup_enabled switch to off-only on UPDATE, but the narrow role that
-- may DELETE and INSERT such a row (a calendar feed, a Microsoft drive)
-- could remove it and insert it again switched on: the one-way rule never
-- met the new row.
--
-- Now the 'off:<col>' rule also meets a new row: on the narrow role an
-- INSERT may not name the switch on (a row starts off; the product's
-- turn-ons run at a full-route spot, as 0323 says). Only 'off' rules look
-- at an INSERT: the others compare a row with its old self, which a new
-- row has none of. Off the narrow route the same insert by a narrow
-- reason is counted (0319's notice) and runs, as an update is.
--
-- 1. mantle_narrow_one_way: its body as 0321 left it, two replaces (the
--    new row read on INSERT too; every rule but 'off' skipped there),
--    each asserted.
-- 2. Every mantle_narrow_one_way_trg trigger with an 'off:' rule fires on
--    INSERT too (generated from the catalog: no hand list), keeping its
--    rules and other events.
--
-- Re-runnable. No table or row changes; no LLM work. Revert:
-- packages/db/rollback/0324_narrow_off_on_insert.revert.sql (before 0323's).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $do$
DECLARE
  def text;
  was text;
BEGIN
  def := pg_catalog.pg_get_functiondef('"public"."mantle_narrow_one_way"()'::regprocedure);
  IF position('IF TG_OP = ''INSERT'' AND kind <> ''off'' THEN' IN def) > 0 THEN
    RETURN;
  END IF;
  was := def;
  def := replace(def,
    E'  IF TG_OP = ''UPDATE'' THEN\n    n := to_jsonb(NEW);\n  END IF;',
    E'  IF TG_OP IN (''UPDATE'', ''INSERT'') THEN\n    n := to_jsonb(NEW);\n  END IF;');
  IF def = was THEN
    RAISE EXCEPTION '0324: mantle_narrow_one_way does not read the new row as 0320 wrote it';
  END IF;
  was := def;
  def := replace(def,
    E'      IF kind = ''keepif'' THEN\n        CONTINUE;\n',
    E'      IF TG_OP = ''INSERT'' AND kind <> ''off'' THEN\n        CONTINUE;\n      ELSIF kind = ''keepif'' THEN\n        CONTINUE;\n');
  IF def = was THEN
    RAISE EXCEPTION '0324: mantle_narrow_one_way does not skip keepif as 0320 wrote it';
  END IF;
  EXECUTE def;
END
$do$;
--> statement-breakpoint
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname::text AS sch, c.relname::text AS tbl,
           array_remove(string_to_array(encode(t.tgargs, 'escape'), '\000'), '') AS args,
           concat_ws(' OR ', 'INSERT',
             CASE WHEN t.tgtype::int & 16 <> 0 THEN 'UPDATE' END,
             CASE WHEN t.tgtype::int & 8 <> 0 THEN 'DELETE' END) AS ev
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE t.tgname = 'mantle_narrow_one_way_trg'
       AND t.tgtype::int & 4 = 0
       AND EXISTS (SELECT 1 FROM unnest(array_remove(string_to_array(encode(t.tgargs, 'escape'), '\000'), '')) a
                    WHERE a LIKE 'off:%')
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
