-- Two writes that scoped code sent as raw SQL or on a system exit become
-- definers, each with its own check, so the login write gateway can send
-- every scoped statement to the write role (no table test in TypeScript).
-- And the Moderator rule of a Telegram bot, which three places held, is
-- one definer that each of them asks (3, 4, 5).
--
-- 1. mantle_ws_system_work (0307) takes one more pair: the actor
--    'system:snapshot-copies' on mantle_file_restamp_home only. Its caller
--    is the boot step and `pnpm maintain snapshot-copies`
--    (server/web/lib/snapshot-copies.ts, systemWork('snapshot-copies')),
--    which never runs inside a scope or a request. Three pairs now (at
--    most five, plan rule 6). The rest of the body is 0307's.
-- 2. mantle_file_restamp_home(node, ws): the home of a snapshot copy whose
--    create lost its name to the files watcher (packages/files ops/files.ts
--    restampRacedCreate): every grant of the row is replaced by one home
--    row in `ws`, Write off. Only as that system work (no acting login, no
--    scope, not read only, the one actor above); the row must be a file of
--    this brain that already carries the copy's stamp (data.snapshot_of:
--    the stamp goes on first). Refused otherwise (42501). It writes what
--    the raw insert did: the same four columns, the rest their defaults.
--    PUBLIC revoked; no viewer role may run it; the runtime role's
--    (runtime-role.ts RUNTIME_SYSTEM_FUNCTIONS: the system pool's login
--    with the runtime role on), never the narrow role's.
-- 3. mantle_tg_login_moderates(owner, login, account): THE Moderator rule
--    of a Telegram bot, in one place: `login` is an enabled Moderator of
--    the live workspace of bot `account`'s assistant (an assistant with no
--    workspace: the owner's Admin workspace), or an Admin user with the
--    users area (mantle_area_rule). The text the three copies of it held
--    (packages/telegram chat-login.ts loginModeratesBot, the moderated
--    chats screen below, the block or unpair below), moved, not
--    rewritten. A read definer: PUBLIC revoked; the runtime role's
--    (runtime-role.ts RUNTIME_SYSTEM_FUNCTIONS: loginModeratesBot calls it
--    on the system pool); the definers call it as their owner.
-- 4. mantle_tg_moderated_chats (0293) asks that rule for each bot instead
--    of its own copy. Its other branches stay as they were: a brain with
--    no Admin workspace answers the anchor login only, and its area ask
--    stays mantle_login_area (0304: the rule above OR'd with "the brain
--    has no Admin workspace", so the answer is the same row for row). The
--    rest of its body is 0293's; CREATE OR REPLACE keeps its grants.
-- 5. mantle_tg_chat_set(owner, login, chat, action, account): block or
--    unpair a Telegram chat (packages/telegram pairing.ts setChatPairing).
--    Refused first for a read-only caller (mantle.write_mode 'ro') and for
--    an owner that is not this brain (42501), as 0307's acting-login check
--    does. The chat of this owner (on bot `account` when given) whose own
--    login is `login`, or for which mantle_tg_login_moderates holds. Any
--    other chat, and a chat that is not there, answer no row (the
--    caller's 404). `block` sets it denied, `unpair` pending; both clear
--    its login and pairing. In a scope, or with an acting login set,
--    `login` must be the scope's own (42501). With no scope and no acting
--    login it does NOT consult mantle_ws_system_work: it acts for the
--    login it is passed, as 0293's Telegram readers do. Only the narrow
--    role and the system pool run without a scope (the assistants area's
--    route on its Admin area exit, which passes the request's login).
--    Answers the chat (id, Telegram id, title, username) and its bot's
--    assistant's name. PUBLIC revoked; the write role's
--    (access-matrix.ts WRITE_ROLE_FUNCTIONS: a login's own routes, in its
--    scope) and the narrow role's (NARROW_SYSTEM_FUNCTIONS: the assistants
--    area's route), granted at boot.
--
-- No row changes. Re-runnable. The `when` sits above 0312's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_system_work"(fn text)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_scope_login_id"() IS NULL
     AND NOT "public"."mantle_scope_active"()
     AND coalesce(current_setting('mantle.write_mode', true), '') <> 'ro'
     AND (coalesce(current_setting('mantle.actor', true), ''), fn) IN (
           ('system:ws-clear-ticks', 'mantle_ws_set_moderator'),
           ('system:boot:migrate-workspaces', 'mantle_ws_attach_assistants'),
           ('system:snapshot-copies', 'mantle_file_restamp_home'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_system_work"(text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_file_restamp_home"(node uuid, ws uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NOT "public"."mantle_ws_system_work"('mantle_file_restamp_home') THEN
    RAISE EXCEPTION 'mantle_file_restamp_home: the snapshot copies'' system work only'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "public"."nodes" n
                  WHERE n."id" = "mantle_file_restamp_home"."node" AND n."type" = 'file'
                    AND n."owner_id" = "public"."mantle_brain_id"()
                    AND coalesce(n."data" ? 'snapshot_of', false)) THEN
    RAISE EXCEPTION 'mantle_file_restamp_home: not a stamped copy of this brain'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM "public"."item_grants" g WHERE g."node_id" = "mantle_file_restamp_home"."node";
  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "is_home", "write")
  VALUES ("mantle_file_restamp_home"."node", "mantle_file_restamp_home"."ws", true, false);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_file_restamp_home"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_tg_login_moderates"(owner uuid, login uuid, account uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
           SELECT 1
             FROM "public"."telegram_accounts" t
             JOIN "public"."channels" ch ON ch."id" = t."channel_id"
             JOIN "public"."agents" a ON a."id" = ch."agent_id" AND a."owner_id" = "mantle_tg_login_moderates"."owner"
             JOIN "public"."workspaces" w
               ON w."id" = coalesce(a."workspace_id",
                                    (SELECT x."id" FROM "public"."workspaces" x
                                      WHERE x."owner_id" = "mantle_tg_login_moderates"."owner" AND x."is_admin"
                                      LIMIT 1))
              AND w."archived_at" IS NULL
             JOIN "public"."workspace_users" u
               ON u."workspace_id" = w."id" AND u."login_id" = "mantle_tg_login_moderates"."login" AND u."moderator"
             JOIN "auth"."users" l ON l."id" = u."login_id" AND l."disabled_at" IS NULL
            WHERE t."id" = "mantle_tg_login_moderates"."account")
      OR "public"."mantle_area_rule"("mantle_tg_login_moderates"."login", 'users')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_tg_login_moderates"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_tg_login_moderates"(uuid, uuid, uuid) TO demo_reader;
  END IF;
END
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
