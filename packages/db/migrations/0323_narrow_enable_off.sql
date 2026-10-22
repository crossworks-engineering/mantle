-- The enable class on the narrow role (the narrow login part b2, round 13b,
-- item D: the re-audit's DB LOW-3). An enable makes something run: a feed
-- syncs and its items are ingested (model work), an AI worker or a backup
-- route takes calls, a worker becomes the kind's default. 0320 held
-- `enabled` only off on four tables; the rest stayed two-way.
--
-- Generated from the catalog, not a hand list: every boolean column named
-- `enabled`, `is_default` or `backup_enabled` of a table in public or auth
-- gets the rule 'off:<col>' in its mantle_narrow_one_way trigger (made, or
-- its rules merged, keeping the rules and events it had). On the narrow
-- role a switch goes only from on to off; off the narrow route the same
-- turn-on by a narrow reason is counted (0319's notice) and runs. The
-- product's turn-ons run at a full-route spot (feed-enable, docs-root,
-- model-route, mail-account). A column made later is caught by the DB
-- test (packages/db src/narrow-rules-13b.db.test.ts), which reads the
-- narrow role's UPDATE rights from the catalog.
--
-- Re-runnable. No table or row changes; no LLM work. Revert:
-- packages/db/rollback/0323_narrow_enable_off.revert.sql (before 0322's).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $do$
DECLARE
  r record;
  args text[];
  ev text;
  want text[];
  x text;
BEGIN
  FOR r IN
    SELECT c.oid AS rel, n.nspname::text AS sch, c.relname::text AS tbl,
           array_agg('off:' || a.attname::text ORDER BY a.attname) AS offs
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.atttypid = 'boolean'::regtype
       AND a.attname IN ('enabled', 'is_default', 'backup_enabled')
     GROUP BY 1, 2, 3
  LOOP
    args := NULL;
    ev := 'UPDATE';
    SELECT array_remove(string_to_array(encode(t.tgargs, 'escape'), '\000'), ''),
           concat_ws(' OR ',
             CASE WHEN t.tgtype::int & 4 <> 0 THEN 'INSERT' END,
             CASE WHEN t.tgtype::int & 16 <> 0 THEN 'UPDATE' END,
             CASE WHEN t.tgtype::int & 8 <> 0 THEN 'DELETE' END)
      INTO args, ev
      FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = r.rel AND t.tgname = 'mantle_narrow_one_way_trg';
    args := coalesce(args, '{}');
    ev := coalesce(nullif(ev, ''), 'UPDATE');
    IF position('UPDATE' IN ev) = 0 THEN
      ev := ev || ' OR UPDATE';
    END IF;
    want := args;
    FOREACH x IN ARRAY r.offs LOOP
      IF NOT x = ANY (want) THEN
        want := want || x;
      END IF;
    END LOOP;
    IF want IS DISTINCT FROM args OR NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_trigger t
          WHERE t.tgrelid = r.rel AND t.tgname = 'mantle_narrow_one_way_trg') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON %I.%I', r.sch, r.tbl);
      EXECUTE format(
        'CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE %s ON %I.%I FOR EACH ROW '
        'EXECUTE FUNCTION "public"."mantle_narrow_one_way"(%s)',
        ev, r.sch, r.tbl,
        (SELECT string_agg(quote_literal(w), ', ' ORDER BY o) FROM unnest(want) WITH ORDINALITY u(w, o)));
    END IF;
  END LOOP;
END
$do$;
