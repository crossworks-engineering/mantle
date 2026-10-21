-- Rollback of 0313_file_home_chat_definers: what an operator runs BEFORE
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- 0313 adds three definers (the Telegram Moderator rule among them), one
-- pair to the SQL system-work allowlist, and points 0293's moderated chats
-- screen at the Moderator rule (the same answers). It changes no table,
-- row, trigger or grant of an earlier function, so the image before it
-- works with 0313 in place (it never calls the new definers, the extra
-- pair only names a definer that image does not call, and the moderated
-- chats screen answers as 0293's). This file makes the catalog exactly
-- that image's again: it puts mantle_tg_moderated_chats back to 0293's
-- body and mantle_ws_system_work to 0307's, byte for byte, drops the
-- three definers, and takes 0313 off the ledger, so a later roll forward
-- applies it again (it is re-runnable). The 0313 cell "the revert" checks
-- it against a database just before 0313.
--
-- Run it while the newer image is still up (this file is in its image,
-- not in a box's stack directory), as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0313_file_home_chat_definers.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback"),
-- or stop mantle_web first: from the revert to the pin the newer image's
-- Telegram block and unpair and its snapshot copies' raced restamp fail
-- (the definers are gone), its Telegram debug screen shows a non-anchor
-- login only its own chats (loginModeratesBot fails closed), and a
-- restart in between runs its boot
-- migrate, which applies 0313 again. The older image's boot grants the
-- write and narrow roles its own function lists, so the grants follow it.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_tg_moderated_chats"(owner uuid, login uuid)
  RETURNS TABLE ("account_id" uuid, "bot_username" text, "agent_name" text, "agent_slug" text,
                 "id" uuid, "telegram_chat_id" text, "title" text, "username" text,
                 "status" text, "last_message_at" timestamptz, "login_id" uuid,
                 "paired_name" text, "paired_email" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH admin_ws AS (
    SELECT w."id" FROM "public"."workspaces" w WHERE w."owner_id" = owner AND w."is_admin" LIMIT 1
  ), bots AS (
    SELECT t."id", t."bot_username", t."created_at", a."name" AS agent_name, a."slug" AS agent_slug
      FROM "public"."telegram_accounts" t
      LEFT JOIN "public"."channels" ch ON ch."id" = t."channel_id"
      LEFT JOIN "public"."agents" a ON a."id" = ch."agent_id"
     WHERE t."user_id" = owner
       AND (NOT "public"."mantle_scope_active"()
            OR (login = "public"."mantle_scope_login_id"() AND owner = "public"."mantle_brain_id"()))
       AND CASE
             WHEN NOT EXISTS (SELECT 1 FROM admin_ws) THEN login = owner
             ELSE EXISTS (
                    SELECT 1
                      FROM "public"."channels" ch2
                      JOIN "public"."agents" a2 ON a2."id" = ch2."agent_id" AND a2."owner_id" = owner
                      JOIN "public"."workspaces" w
                        ON w."id" = coalesce(a2."workspace_id", (SELECT "id" FROM admin_ws))
                       AND w."archived_at" IS NULL
                      JOIN "public"."workspace_users" u
                        ON u."workspace_id" = w."id" AND u."login_id" = login AND u."moderator"
                      JOIN "auth"."users" l ON l."id" = u."login_id" AND l."disabled_at" IS NULL
                     WHERE ch2."id" = t."channel_id")
                  OR "public"."mantle_login_area"(login, 'users')
           END
  )
  SELECT b."id", b."bot_username", b.agent_name, b.agent_slug,
         c."id", c."telegram_chat_id", c."title", c."username", c."allowlist_status"::text,
         c."last_message_at", c."login_id", l."display_name", l."email"
    FROM bots b
    JOIN "public"."telegram_chats" c ON c."account_id" = b."id" AND c."user_id" = owner
    LEFT JOIN "auth"."users" l ON l."id" = c."login_id"
   ORDER BY b."created_at", b."id"
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_tg_chat_set"(uuid, uuid, uuid, text, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_file_restamp_home"(uuid, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_tg_login_moderates"(uuid, uuid, uuid);
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
