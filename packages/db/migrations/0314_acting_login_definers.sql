-- With no scope, a definer that acts for a login takes only the acting
-- login (plan v3.2 S7b part b1): the login whose request or turn the
-- system work runs for, which the gateway sends as mantle.acting_login
-- with the actor's settings (packages/db actor.ts actingLoginOf,
-- gateway/actor-sql.ts setActorSql; on the narrow route always, on the
-- full route for a request exit's actor in every check mode). No other
-- statement may name the setting on the narrow route (narrow-sendable.ts
-- GATEWAY_SETTING). So no caller with no scope can name a login it is not.
--
-- 1. mantle_tg_chat_set (0313): in a scope, or with a scope login set, the
--    login must be the scope's own, as before. With neither, the login
--    must be the acting login: none set, or another, is refused (42501,
--    nothing changes). Its callers with no scope: the assistants area's
--    route (POST /api/agents/:id/telegram/chats on its Admin area exit),
--    which passes the request's own login, the acting login. The rest of
--    the body is 0313's.
-- 2. mantle_access_key_revoke (0293): the same rule. Its one caller
--    (DELETE /api/access-keys/:id) runs in the login's own scope on the
--    write role; no product path reaches it with no scope. The rest of the
--    body is 0293's.
--
-- Not changed, each a reader with a caller that has no acting login, or a
-- fact about a login another login may ask (docs/runtime-role.md, "The
-- acting login"): mantle_tg_my_chats, mantle_tg_moderated_chats,
-- mantle_read_cursors, mantle_login_connector_rows, mantle_turn_heartbeats
-- (the heartbeat tick, a worker), mantle_ws_seen, mantle_access_keys_seen,
-- mantle_snapshot_bytes, mantle_area_rule, mantle_login_area(s),
-- mantle_login_is_admin(_user), mantle_ws_private_for,
-- mantle_ws_private_workspace, mantle_personal_space, mantle_tg_login_moderates;
-- and the Admin acts on a target login (mantle_ws_remove_user,
-- mantle_bridge_login), which check the actor's own rights.
--
-- CREATE OR REPLACE keeps each function's grants. No table, row or
-- trigger changes; no LLM work. Re-runnable. The `when` sits above 0313's.
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
  IF ("public"."mantle_scope_active"() OR "public"."mantle_scope_login_id"() IS NOT NULL) THEN
    IF "mantle_tg_chat_set"."login" IS DISTINCT FROM "public"."mantle_scope_login_id"() THEN
      RAISE EXCEPTION 'mantle_tg_chat_set: only the scope''s own login' USING ERRCODE = '42501';
    END IF;
  ELSIF "mantle_tg_chat_set"."login" IS DISTINCT FROM
        nullif(current_setting('mantle.acting_login', true), '')::uuid THEN
    RAISE EXCEPTION 'mantle_tg_chat_set: only the acting login' USING ERRCODE = '42501';
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
  ELSIF login IS DISTINCT FROM nullif(current_setting('mantle.acting_login', true), '')::uuid THEN
    RAISE EXCEPTION 'mantle_access_key_revoke: only the acting login' USING ERRCODE = '42501';
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
