-- One-time pairing codes for "Sign in on your phone" (QR sign-in for the
-- mobile companion). The web app mints a code (POST /api/auth/pair), the
-- phone claims it (POST /api/auth/pair/claim) for a mobile_tokens bearer.
-- Stored hashed; single-use; ~90 s TTL. See packages/db/src/schema/pairing-codes.ts
-- and server/web/lib/pair-code.ts.

CREATE TABLE "pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL UNIQUE,
	"user_id" uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	"claimed_at" timestamp with time zone,
	"claimed_device_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "pairing_codes_user_idx" ON "pairing_codes" ("user_id");
