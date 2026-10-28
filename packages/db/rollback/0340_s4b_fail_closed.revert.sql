-- Rollback of 0340_s4b_fail_closed: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional: the older image counts the two branches, and every brain has
-- an Admin workspace, so both functions answer the same with or without
-- this. It puts 0304's mantle_login_area and 0313's
-- mantle_tg_moderated_chats back (each with its "no Admin workspace"
-- branch) and takes 0340 off the ledger, so the next roll forward applies
-- it again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0340_s4b_fail_closed.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_area"(login uuid, area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                      WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin")
      OR "public"."mantle_area_rule"(login, area)
$$;
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
             ELSE "public"."mantle_tg_login_moderates"(owner, login, t."id")
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
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200560000;
