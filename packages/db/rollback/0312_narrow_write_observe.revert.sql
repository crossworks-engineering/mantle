-- Rollback of 0312_narrow_write_observe: what an operator runs BEFORE
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- 0312 only counts (report only): the image before it works with 0312 in
-- place (its pool prints the new notices as plain notices and writes no
-- row for them). This file makes the catalog exactly that image's again:
-- the actor check's function as 0277 made it, the cascade triggers and
-- their function dropped, mantle_narrow_actor dropped, and 0312 taken off
-- the ledger, so a later roll forward applies it again (it is
-- re-runnable). The miss rows 0312's counts wrote stay in
-- actor_check_misses (the image before ignores their check names; the
-- maintenance reap deletes them after 14 days). The 0312 cell "the revert
-- leaves the catalog as before 0312" checks it against a database just
-- before 0312.
--
-- Run it while the newer image is still up (this file is in its image,
-- not in a box's stack directory), as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0312_narrow_write_observe.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image (docs/update-prod.md "Rollback"). A restart in
-- between runs the newer image's boot migrate, which applies 0312 again:
-- harmless (it only counts), the revert runs again before the pin.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "auth"."users";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "public"."spaces";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "public"."agents";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_cascade_stmt"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  seen_key text := 'mantle.actor_missed_' || TG_TABLE_NAME;
  mode text;
BEGIN
  IF coalesce(current_setting('mantle.actor', true), '') <> '' OR pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  mode := "public"."mantle_actor_check_mode"();
  IF mode = 'off' THEN RETURN NULL; END IF;
  IF mode = 'on' THEN
    RAISE EXCEPTION 'mantle actor check: % on % with no actor', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '42501', DETAIL = 'no_actor';
  END IF;
  IF coalesce(current_setting(seen_key, true), '') = TG_OP THEN RETURN NULL; END IF;
  PERFORM set_config(seen_key, TG_OP, true);
  RAISE NOTICE 'mantle actor miss: % on %', TG_OP, TG_TABLE_NAME;
  RETURN NULL;
END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_actor"(text);
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0312 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198040000;
