-- Client sign-in code outcomes and upkeep (client logins C2/C2b audit, B2,
-- B3, B4). Three small things, all metadata on small tables:
--
--   - client_signin_codes.sent_at / send_error: what became of each code
--     mail. The admin card counted every stored code as "sent", failed sends
--     too; now it counts the ones the mail server took (sent_at) and shows
--     the newest failure (send_error, a short reason, never the code).
--   - client_signin_code_skips: one row per code request skipped because a
--     send cap was hit (per email plus address, per login, brain-wide), so
--     the admin card can say that someone is using up a client's codes. The
--     reason only: no email, no address, no login.
--   - client_signin_sender_folders: the sent-mail folders choosing an
--     account as the sign-in sender added to its imap_excluded_folders,
--     exactly those, so choosing another sender or none puts them back.
--     Cascades with the account.
--
-- The maintenance reaper (client-codes-reap) deletes old rows of the first
-- two. No viewer role reads any of them (the access matrix: none).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."client_signin_codes" ADD COLUMN IF NOT EXISTS "sent_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "public"."client_signin_codes" ADD COLUMN IF NOT EXISTS "send_error" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."client_signin_code_skips" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_signin_code_skips_created_idx"
  ON "public"."client_signin_code_skips" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."client_signin_sender_folders" (
  "account_id" uuid PRIMARY KEY NOT NULL
    REFERENCES "public"."email_accounts"("id") ON DELETE CASCADE,
  "folders" text[] NOT NULL DEFAULT '{}'::text[],
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
