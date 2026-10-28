-- The SQL fail-open branches go (workspaces arch plan v3.2, S4b). Each
-- answered for a brain with no Admin workspace; the box count "brains
-- without an Admin workspace" read 0 on every box for a full release
-- before this, so no brain takes either.
--
-- 1. mantle_login_area(login, area) (0304): "the brain has no Admin
--    workspace: yes" OR mantle_area_rule. Now the rule alone: with no
--    Admin workspace no login holds an area, as the strict facts
--    (mantle_area_rule, mantle_login_areas, mantle_login_is_admin) already
--    answer.
-- 2. mantle_tg_moderated_chats(owner, login) (0313): with no Admin
--    workspace it answered the anchor login's chats. Now every brain asks
--    the same two things: the login moderates the bot, or holds the users
--    area. The rest of its body is 0313's.
--
-- CREATE OR REPLACE keeps both functions' owner, SECURITY DEFINER and
-- grants. No table, row or trigger changes. Re-runnable.
-- Rollback: packages/db/rollback/0340_s4b_fail_closed.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_area"(login uuid, area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_area_rule"(login, area)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_tg_moderated_chats"(owner uuid, login uuid)
  RETURNS TABLE ("account_id" uuid, "bot_username" text, "agent_name" text, "agent_slug" text,
                 "id" uuid, "telegram_chat_id" text, "title" text, "username" text,
                 "status" text, "last_message_at" timestamptz, "login_id" uuid,
                 "paired_name" text, "paired_email" text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH bots AS (
    SELECT t."id", t."bot_username", t."created_at", a."name" AS agent_name, a."slug" AS agent_slug
      FROM "public"."telegram_accounts" t
      LEFT JOIN "public"."channels" ch ON ch."id" = t."channel_id"
      LEFT JOIN "public"."agents" a ON a."id" = ch."agent_id"
     WHERE t."user_id" = owner
       AND (NOT "public"."mantle_scope_active"()
            OR (login = "public"."mantle_scope_login_id"() AND owner = "public"."mantle_brain_id"()))
       AND ("public"."mantle_tg_login_moderates"(owner, login, t."id")
            OR "public"."mantle_login_area"(login, 'users'))
  )
  SELECT b."id", b."bot_username", b.agent_name, b.agent_slug,
         c."id", c."telegram_chat_id", c."title", c."username", c."allowlist_status"::text,
         c."last_message_at", c."login_id", l."display_name", l."email"
    FROM bots b
    JOIN "public"."telegram_chats" c ON c."account_id" = b."id" AND c."user_id" = owner
    LEFT JOIN "auth"."users" l ON l."id" = c."login_id"
   ORDER BY b."created_at", b."id"
$$;
