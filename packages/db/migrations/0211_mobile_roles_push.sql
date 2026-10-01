-- Members and clients on the phone app (docs/mobile-companion-backend.md,
-- "Three roles on the phone").
--
-- 1. push_subscriptions.token_id: the device token (mobile_tokens row) that
--    enrolled the device. A member's or a client's device gets a push only
--    while that token is live, so a signed-out or revoked phone gets nothing.
--    NULL on rows from before this release (admin devices): those keep the
--    login-level rule they had.
-- 2. push_login_prefs: per-login push toggles (chat replies, review results,
--    comments). No row means all on.
-- 3. login_chat_read_cursors: how far a member or a client has read its own
--    chat thread (team_messages by login). team_read_cursors is the admin
--    side and is keyed by contact.
-- 4. login_notice: one NOTIFY channel for what a member or a client is told
--    about on its phone. Raised by triggers, as needs_you_changed (0186) is,
--    so no write path can forget it:
--      * a finished outbound row in a login's own chat thread (the
--        responder's reply, or an admin's note through team-admin/notify);
--      * an item's review state becoming accepted, returned or taken;
--      * a new comment.
--    The payload carries ids only, never text. The push worker reads the
--    rows on the admin pool, decides who may be told, and sends. Notify-only:
--    these functions write nothing and no listener starts LLM work
--    (cost-safety).

-- The space_items trigger takes an exclusive lock on a hot table: wait at
-- most 30 s for it, then fail and stop the roll (0186 does the same).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "push_subscriptions" ADD COLUMN IF NOT EXISTS "token_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_token_fk') THEN
    ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_token_fk"
      FOREIGN KEY ("token_id") REFERENCES "mobile_tokens"("id") ON DELETE CASCADE;
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_token_idx" ON "push_subscriptions" ("token_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "push_login_prefs" (
  "login_id" uuid PRIMARY KEY REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "chat_replies" boolean NOT NULL DEFAULT true,
  "review_results" boolean NOT NULL DEFAULT true,
  "comments" boolean NOT NULL DEFAULT true,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "login_chat_read_cursors" (
  "login_id" uuid PRIMARY KEY REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "last_read_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_notify_login_chat"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'login_notice',
    json_build_object('kind', 'chat', 'loginId', new.login_id, 'id', new.id)::text
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_notify_login_chat"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "team_messages_login_notice_ins_trg" ON "public"."team_messages";
--> statement-breakpoint
-- A row inserted already finished: an admin's note, or a reply that was
-- never a "thinking" bubble.
CREATE TRIGGER "team_messages_login_notice_ins_trg"
  AFTER INSERT ON "public"."team_messages"
  FOR EACH ROW
  WHEN (new.direction = 'outbound' AND new.login_id IS NOT NULL AND new.status = 'complete')
  EXECUTE FUNCTION "public"."mantle_notify_login_chat"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "team_messages_login_notice_upd_trg" ON "public"."team_messages";
--> statement-breakpoint
-- The "thinking" bubble finalized. A failed reply never notifies.
CREATE TRIGGER "team_messages_login_notice_upd_trg"
  AFTER UPDATE OF "status" ON "public"."team_messages"
  FOR EACH ROW
  WHEN (new.direction = 'outbound' AND new.login_id IS NOT NULL
        AND new.status = 'complete' AND old.status IS DISTINCT FROM 'complete')
  EXECUTE FUNCTION "public"."mantle_notify_login_chat"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_notify_login_review"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'login_notice',
    json_build_object('kind', 'review', 'loginId', new.author_login_id,
                      'id', new.node_id, 'state', new.review_state)::text
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_notify_login_review"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "space_items_login_notice_upd_trg" ON "public"."space_items";
--> statement-breakpoint
-- A review result for the author: accepted, returned (a Return or a give
-- back), or taken over by an admin. Submit, Recall and saves never fire.
CREATE TRIGGER "space_items_login_notice_upd_trg"
  AFTER UPDATE OF "review_state" ON "public"."space_items"
  FOR EACH ROW
  WHEN (old.review_state IS DISTINCT FROM new.review_state
        AND new.review_state IN ('accepted', 'returned', 'taken')
        AND new.author_login_id IS NOT NULL)
  EXECUTE FUNCTION "public"."mantle_notify_login_review"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_notify_login_comment"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'login_notice',
    json_build_object('kind', 'comment', 'id', new.id)::text
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_notify_login_comment"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "node_comments_login_notice_ins_trg" ON "public"."node_comments";
--> statement-breakpoint
CREATE TRIGGER "node_comments_login_notice_ins_trg"
  AFTER INSERT ON "public"."node_comments"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."mantle_notify_login_comment"();
