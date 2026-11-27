-- Rollback of 0401_structure_item_no_secret. Not a migration: nothing runs
-- it on its own.
--
-- A one-image rollback does NOT need this file. 0401 takes the kind
-- 'secret-item' off mantle_structure_item's list and changes nothing else,
-- and the image one release back (0400) never calls the kind. Only an image
-- from before 0400 writes a secret through the kind: a rollback that far
-- runs this file first, then 0400's revert.
--
-- This file puts the kind's two lines back, each after the 'secrets-root'
-- line that stays (the definition is then what it was before 0401, byte
-- for byte), and takes 0401 off the ledger, so the next roll forward runs
-- it again (0401 is re-runnable). A second run finds the lines there and
-- changes nothing.
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0401_structure_item_no_secret.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $do$
DECLARE
  fn constant regprocedure :=
    to_regprocedure('public.mantle_structure_item(text,text,uuid,uuid,uuid[],jsonb)');
  root_row constant text :=
    'WHEN ''secrets-root'' THEN t := ''branch''; need_area := ''keys''; ops := ARRAY[''insert''];';
  root_place constant text := 'WHEN ''secrets-root'' THEN place = ''secrets''::ltree';
  def text;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION '0401 revert: mantle_structure_item is missing';
  END IF;
  def := pg_catalog.pg_get_functiondef(fn);
  IF def NOT LIKE '%secret-item%' THEN
    def := replace(def, root_row, root_row || E'\n'
      || '    WHEN ''secret-item'' THEN t := ''secret''; need_area := ''keys''; ops := ARRAY[''insert'', ''update'', ''delete''];');
    def := replace(def, root_place, root_place || E'\n'
      || '               WHEN ''secret-item'' THEN place = ''secrets''::ltree');
    EXECUTE def;
  END IF;
  -- The end state: both lines are there.
  IF (SELECT (length(p.prosrc) - length(replace(p.prosrc, 'WHEN ''secret-item'' THEN', '')))
             / length('WHEN ''secret-item'' THEN')
        FROM pg_catalog.pg_proc p WHERE p.oid = fn) <> 2 THEN
    RAISE EXCEPTION '0401 revert: mantle_structure_item does not hold the two secret-item lines';
  END IF;
END
$do$;
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0401 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792340420000;
