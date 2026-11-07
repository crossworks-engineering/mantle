-- Rollback of 0365_app_draft_agent_edited: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It drops apps.draft_agent_edited (the older image neither reads nor
-- writes it) and takes 0365 off the ledger, so the next roll forward runs
-- it again. A draft an agent edited is then a draft like any other: the
-- older image's broker runs its calls, as it did before 0365.
--
-- The edit check's column trigger on apps (mantle_edit_check_cols_manage,
-- made by the access matrix sync on every migrate) names the column, so
-- the column cannot simply go: each matrix-made trigger that depends on it
-- is rebuilt first from its own definition without the column, keeping its
-- note and its enabled or disabled state (the box's edit check mode), and
-- the column then goes without CASCADE. The older image's sync then finds
-- the trigger's note unlike its own and makes it again as its matrix says.
-- A definition the rebuild cannot rid of the column stops the revert, and
-- nothing changes (one transaction).
--
-- Pin the older image first (the newer one writes the column on every
-- draft save and reads it in every app tool call: with the column gone it
-- would fail them), then run it as the superuser, in one transaction:
--   cat packages/db/rollback/0365_app_draft_agent_edited.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- (the file read from this repository, as the older image does not hold
-- it; docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
LOCK TABLE "public"."apps" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  r record;
  def text;
  note text;
BEGIN
  FOR r IN
    SELECT DISTINCT tg.oid, tg.tgname::text AS name, tg.tgenabled
      FROM pg_trigger tg
      JOIN pg_depend d ON d.classid = 'pg_trigger'::regclass AND d.objid = tg.oid
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE tg.tgrelid = 'public.apps'::regclass AND NOT tg.tgisinternal
       AND d.refclassid = 'pg_class'::regclass AND a.attname = 'draft_agent_edited'
  LOOP
    IF r.name NOT LIKE 'mantle\_edit\_check\_%' THEN
      RAISE EXCEPTION '0365 revert: trigger % on apps names draft_agent_edited and is no edit check', r.name;
    END IF;
    def := pg_get_triggerdef(r.oid);
    note := obj_description(r.oid, 'pg_trigger');
    -- The column out of the UPDATE OF list and out of the WHEN's changes.
    def := regexp_replace(def, ', draft_agent_edited\M', '', 'g');
    def := regexp_replace(def, '\mdraft_agent_edited, ', '', 'g');
    def := regexp_replace(def,
      ' OR \(old\.draft_agent_edited IS DISTINCT FROM new\.draft_agent_edited\)', '', 'g');
    def := regexp_replace(def,
      '\(old\.draft_agent_edited IS DISTINCT FROM new\.draft_agent_edited\) OR ', '', 'g');
    IF def LIKE '%draft_agent_edited%' THEN
      RAISE EXCEPTION '0365 revert: trigger % still names draft_agent_edited: %', r.name, def;
    END IF;
    EXECUTE format('DROP TRIGGER %I ON "public"."apps"', r.name);
    EXECUTE def;
    IF note IS NOT NULL THEN
      EXECUTE format('COMMENT ON TRIGGER %I ON "public"."apps" IS %L', r.name, note);
    END IF;
    IF r.tgenabled = 'D' THEN
      EXECUTE format('ALTER TABLE "public"."apps" DISABLE TRIGGER %I', r.name);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "public"."apps" DROP COLUMN IF EXISTS "draft_agent_edited";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791583503000;
