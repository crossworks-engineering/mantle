-- Rollback of 0313_file_home_chat_definers: what an operator runs BEFORE
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- 0313 adds two definers and one pair to the SQL system-work allowlist. It
-- changes no table, row, trigger or grant of an earlier function, so the
-- image before it works with 0313 in place (it never calls either definer,
-- and the extra pair only names a definer that image does not call). This
-- file makes the catalog exactly that image's again: it drops the two
-- definers, puts mantle_ws_system_work back to 0307's body byte for byte,
-- and takes 0313 off the ledger, so a later roll forward applies it again
-- (it is re-runnable). The 0313 cell "the revert" checks it against a
-- database just before 0313.
--
-- Run it while the newer image is still up (this file is in its image,
-- not in a box's stack directory), as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0313_file_home_chat_definers.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback"),
-- or stop mantle_web first: from the revert to the pin the newer image's
-- Telegram block and unpair and its snapshot copies' raced restamp fail
-- (the definers are gone), and a restart in between runs its boot
-- migrate, which applies 0313 again. The older image's boot grants the
-- write and narrow roles its own function lists, so the grants follow it.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_tg_chat_set"(uuid, uuid, uuid, text, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_file_restamp_home"(uuid, uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_system_work"(fn text)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_scope_login_id"() IS NULL
     AND NOT "public"."mantle_scope_active"()
     AND coalesce(current_setting('mantle.write_mode', true), '') <> 'ro'
     AND (coalesce(current_setting('mantle.actor', true), ''), fn) IN (
           ('system:ws-clear-ticks', 'mantle_ws_set_moderator'),
           ('system:boot:migrate-workspaces', 'mantle_ws_attach_assistants'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_system_work"(text) FROM PUBLIC;
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0313 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198100000;
