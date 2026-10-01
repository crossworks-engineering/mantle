-- Email sign-in codes (client logins, Phase C2b; plan section 4). A client
-- asks for a code by email; the email-sync worker makes it and mails it from
-- the brain's sign-in sender. The codes live in client_signin_codes (0188)
-- with kind 'email', tied to the browser that asked (request_id). This adds
-- where the request came from, so the send caps count per email PLUS
-- address (a stranger cannot use up a client's codes), and the indexes the
-- verify and the caps read by. Metadata only: a nullable column and two
-- indexes on a small table; lock_timeout keeps it from queueing behind a
-- long reader.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."client_signin_codes" ADD COLUMN IF NOT EXISTS "request_ip" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_signin_codes_request_idx"
  ON "public"."client_signin_codes" ("request_id")
  WHERE "request_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_signin_codes_kind_created_idx"
  ON "public"."client_signin_codes" ("kind", "created_at");
