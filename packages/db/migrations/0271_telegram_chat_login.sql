-- Workspaces W7d: Telegram per paired user.
--
-- A paired Telegram chat now belongs to a USER (plan 5.4): telegram_chats
-- gains login_id, set when that user pairs the chat with its code while
-- signed in. A turn on the chat runs as that login, in the workspace of the
-- bot's assistant; a chat with no login, or whose login is no longer a user
-- of that workspace, is refused on its next message.
--
-- Until now every paired chat acted as the brain owner (the anchor login),
-- so every allowed chat is stamped with the anchor (telegram_chats.user_id,
-- the brain's anchor login). Nothing else changes for it.
--
-- A chat whose login is then not a user of the workspace of the assistant it
-- runs as (the bot's own assistant, and the chat's responder override when
-- it has one; an assistant with no workspace counts the Admin workspace)
-- goes back to pending with no login, and is listed by a NOTICE. Nobody is
-- ever added to a workspace here. A brain that is not on workspaces yet (no
-- Admin workspace) skips that check.
--
-- Re-runnable: the column, its key and its index are added only when
-- missing; the stamp touches only allowed chats with no login; a chat sent
-- back to pending has no login and is not allowed, so a second run changes
-- nothing. No notify fires on these UPDATEs and no LLM work is queued.
--
-- The `when` sits above 1790195460000 (0270's): migrate.ts skips a
-- migration whose `when` is at or below the highest one applied.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- The table this migration alters, and the login table its new key points
-- at, in one statement with a short wait and a retry, like 0269 and 0270.
DO $$
DECLARE
  attempt int := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      LOCK TABLE "public"."telegram_chats" IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE "auth"."users" IN SHARE ROW EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= 20 THEN
        RAISE EXCEPTION '0271: the tables stayed busy for 20 attempts; run the migration again at a quieter time'
          USING ERRCODE = 'lock_not_available';
      END IF;
      RAISE NOTICE '0271: tables busy (attempt %), retrying', attempt;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "public"."telegram_chats" ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telegram_chats_login_id_fk'
  ) THEN
    ALTER TABLE "public"."telegram_chats"
      ADD CONSTRAINT "telegram_chats_login_id_fk"
      FOREIGN KEY ("login_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_chats_login_idx" ON "public"."telegram_chats" ("login_id");
--> statement-breakpoint
-- Every allowed chat acted as the anchor: it is the anchor's.
UPDATE "public"."telegram_chats"
   SET "login_id" = "user_id"
 WHERE "allowlist_status" = 'allowed' AND "login_id" IS NULL;
--> statement-breakpoint
-- An allowed chat whose login is not a user of its assistant's workspace
-- goes back to pending, listed.
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT c."id", c."account_id", c."login_id"
      FROM "public"."telegram_chats" c
     WHERE c."allowlist_status" = 'allowed'
       AND EXISTS (
         SELECT 1 FROM "public"."workspaces" aw
          WHERE aw."owner_id" = c."user_id" AND aw."is_admin"
       )
       AND (
         c."login_id" IS NULL
         OR EXISTS (
           SELECT 1
             FROM "public"."agents" a
            WHERE a."owner_id" = c."user_id"
              AND (
                a."id" = c."responder_agent_id"
                OR a."id" IN (
                  SELECT ch."agent_id"
                    FROM "public"."channels" ch
                    JOIN "public"."telegram_accounts" t ON t."channel_id" = ch."id"
                   WHERE t."id" = c."account_id"
                )
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM "public"."workspaces" w
                  JOIN "public"."workspace_users" u
                    ON u."workspace_id" = w."id" AND u."login_id" = c."login_id"
                 WHERE w."archived_at" IS NULL
                   AND w."id" = coalesce(
                     a."workspace_id",
                     (SELECT aw."id" FROM "public"."workspaces" aw
                       WHERE aw."owner_id" = c."user_id" AND aw."is_admin" LIMIT 1)
                   )
              )
         )
       )
  LOOP
    RAISE NOTICE '0271: telegram chat % (account %) back to pending: login % is not a user of its assistant''s workspace',
      r."id", r."account_id", coalesce(r."login_id"::text, 'none');
    UPDATE "public"."telegram_chats"
       SET "allowlist_status" = 'pending',
           "login_id" = NULL,
           "pairing_code" = NULL,
           "pairing_expires_at" = NULL,
           "pairing_replies" = 0,
           "updated_at" = now()
     WHERE "id" = r."id";
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0271: % telegram chat(s) back to pending', n;
END
$$;
