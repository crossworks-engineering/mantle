-- Client sign-in codes (client logins, Phase C2; plan section 4). A client
-- login has no password: it signs in with a code. In C2 an admin issues a
-- sign-in LINK (kind 'admin_link'): 72 hours, one use, about 92 bits, only
-- the SHA-256 stored, the client types their email on the link page as a
-- check. C2b adds emailed codes (kind 'email') with request_id and attempts.
-- See packages/content/src/client-logins.ts.
--
-- owner_id is the brain anchor, like member_invites. login_id cascades: a
-- deleted login takes its codes with it. A new table only: metadata, cheap
-- on a live database. No viewer role reads it (the access matrix: none).

CREATE TABLE IF NOT EXISTS "public"."client_signin_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "login_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "code_hash" text NOT NULL UNIQUE,
  "request_id" uuid,
  "expires_at" timestamptz NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "client_signin_codes_kind_ck" CHECK ("kind" IN ('admin_link', 'email'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_signin_codes_login_idx"
  ON "public"."client_signin_codes" ("login_id", "created_at" DESC);
