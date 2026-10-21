-- Rollback of 0314_acting_login_definers: what an operator runs BEFORE
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- 0314 changes two definers' bodies (mantle_tg_chat_set, 0313's;
-- mantle_access_key_revoke, 0293's): with no scope each takes only the
-- acting login. The image before it sends no mantle.acting_login, so with
-- 0314 in place its assistants area's Telegram block and unpair are
-- refused (42501): run this before pinning it. It puts both bodies back
-- byte for byte and takes 0314 off the ledger, so a later roll forward
-- applies it again (it is re-runnable). CREATE OR REPLACE keeps the
-- grants. The 0314 cell "the revert" checks the bodies' md5 against the
-- ones before 0314.
--
-- Run it while the newer image is still up (this file is in its image),
-- as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0314_acting_login_definers.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_tg_chat_set"(
  owner uuid, login uuid, chat uuid, action text, account uuid)
  RETURNS TABLE ("id" uuid, "telegram_chat_id" text, "title" text, "username" text,
                 "agent_name" text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  c "public"."telegram_chats"%ROWTYPE;
BEGIN
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RAISE EXCEPTION 'mantle_tg_chat_set: a read-only caller' USING ERRCODE = '42501';
  END IF;
  IF "mantle_tg_chat_set"."owner" IS DISTINCT FROM "public"."mantle_brain_id"() THEN
    RAISE EXCEPTION 'mantle_tg_chat_set: only on this brain' USING ERRCODE = '42501';
  END IF;
  IF "mantle_tg_chat_set"."action" IS NULL
     OR "mantle_tg_chat_set"."action" NOT IN ('block', 'unpair') THEN
    RAISE EXCEPTION 'mantle_tg_chat_set: the action is block or unpair' USING ERRCODE = '22023';
  END IF;
  IF ("public"."mantle_scope_active"() OR "public"."mantle_scope_login_id"() IS NOT NULL)
     AND "mantle_tg_chat_set"."login" IS DISTINCT FROM "public"."mantle_scope_login_id"() THEN
    RAISE EXCEPTION 'mantle_tg_chat_set: only the scope''s own login' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO c FROM "public"."telegram_chats" t
   WHERE t."id" = "mantle_tg_chat_set"."chat" AND t."user_id" = "mantle_tg_chat_set"."owner"
     AND ("mantle_tg_chat_set"."account" IS NULL OR t."account_id" = "mantle_tg_chat_set"."account")
     FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  -- Its own login, else the bot's Moderator rule. Nobody else's chat is
  -- named: no row.
  IF NOT coalesce(c."login_id" = "mantle_tg_chat_set"."login", false)
     AND NOT "public"."mantle_tg_login_moderates"("mantle_tg_chat_set"."owner",
                                                  "mantle_tg_chat_set"."login", c."account_id") THEN
    RETURN;
  END IF;
  UPDATE "public"."telegram_chats" t
     SET "allowlist_status" = CASE WHEN "mantle_tg_chat_set"."action" = 'block'
                                   THEN 'denied' ELSE 'pending' END::"public"."telegram_allowlist_status",
         "login_id" = NULL, "pairing_code" = NULL, "pairing_expires_at" = NULL,
         "pairing_replies" = 0, "updated_at" = now()
   WHERE t."id" = c."id";
  RETURN QUERY
    SELECT c."id", c."telegram_chat_id", c."title", c."username",
           (SELECT a."name" FROM "public"."telegram_accounts" t
              JOIN "public"."channels" ch ON ch."id" = t."channel_id"
              JOIN "public"."agents" a ON a."id" = ch."agent_id"
             WHERE t."id" = c."account_id"
             LIMIT 1);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_tg_chat_set"(uuid, uuid, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_access_key_revoke"(key uuid, login uuid)
  RETURNS TABLE ("id" uuid, "key_prefix" text, "name" text, "login_id" uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  who uuid := login;
BEGIN
  IF "public"."mantle_scope_active"() THEN
    IF login IS DISTINCT FROM "public"."mantle_scope_login_id"() THEN
      RAISE EXCEPTION 'mantle_access_key_revoke: only the scope''s own login' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN QUERY
  UPDATE "public"."access_keys" a SET "revoked_at" = now(), "revoked_by" = who
   WHERE a."id" = key AND a."revoked_at" IS NULL
     AND (a."login_id" = who OR "public"."mantle_login_is_admin_user"(who))
  RETURNING a."id", a."key_prefix", a."name", a."login_id";
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_access_key_revoke"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0314 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198160000;
