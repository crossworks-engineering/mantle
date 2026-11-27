-- The structure definer no longer takes a secret (plan page 0f5ce59b, the
-- S2 audit's follow-up N4). Since 0400 a secret is a workspace kind: its
-- item is written in the caller's own scope by the write role, and its
-- sealed value through mantle_secret_put. No code calls the kind
-- 'secret-item' of mantle_structure_item (0316) any more, but the function
-- still took it, with insert, update and delete. So a login with the keys
-- area could still write any secret item of the brain past the workspace
-- rules. This takes the kind off the function's list: 'secret-item' is now
-- "not a listed kind" (42501), as any other unlisted kind. The Secrets root
-- ('secrets-root', a folder with no content) stays.
--
-- How: the live definition (pg_get_functiondef) less the kind's two lines,
-- the way 0322 rewrote the same function. Every other line stays as it is,
-- 0322's acting login reader included. pg_get_functiondef keeps SECURITY
-- DEFINER and the SET clauses; CREATE OR REPLACE keeps the owner and the
-- grants. It raises when the function is missing, and when its source
-- still names the kind after the rewrite (a line in a form not rewritten).
--
-- No table, row or trigger changes; no LLM work. Re-runnable (a second run
-- finds no line to remove and changes nothing). Revert:
-- packages/db/rollback/0401_structure_item_no_secret.revert.sql (not needed
-- for a one-image rollback: the image before this one never calls the
-- kind). The `when` sits 60000 above 0400's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $do$
DECLARE
  fn constant regprocedure :=
    to_regprocedure('public.mantle_structure_item(text,text,uuid,uuid,uuid[],jsonb)');
  was text;
  def text;
  src text;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION '0401: mantle_structure_item is missing';
  END IF;
  was := pg_catalog.pg_get_functiondef(fn);
  -- Each line whole, from its indent to its line end: the kind's row of the
  -- list (type, area, operations), then where a new one lands.
  def := regexp_replace(was,
    '[ \t]*WHEN ''secret-item'' THEN t := ''secret''; need_area := ''keys''; ops := ARRAY\[''insert'', ''update'', ''delete''\];[ \t\r]*\n',
    '');
  def := regexp_replace(def,
    '[ \t]*WHEN ''secret-item'' THEN place = ''secrets''::ltree[ \t\r]*\n',
    '');
  IF def LIKE '%secret-item%' THEN
    RAISE EXCEPTION '0401: mantle_structure_item names secret-item in a form not rewritten';
  END IF;
  IF def IS DISTINCT FROM was THEN
    EXECUTE def;
  END IF;
  -- The end state, not what this run rewrote (a second run rewrites none).
  SELECT p.prosrc INTO src FROM pg_catalog.pg_proc p WHERE p.oid = fn;
  IF src LIKE '%secret-item%' THEN
    RAISE EXCEPTION '0401: mantle_structure_item still names secret-item';
  END IF;
  IF src NOT LIKE '%WHEN ''secrets-root'' THEN t := ''branch''; need_area := ''keys''; ops := ARRAY[''insert''];%'
     OR src NOT LIKE '%WHEN ''secrets-root'' THEN place = ''secrets''::ltree%' THEN
    RAISE EXCEPTION '0401: mantle_structure_item lost the Secrets root';
  END IF;
END
$do$;
