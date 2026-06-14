-- Per-device bearer tokens for the mobile companion app. The token handed to
-- the device is HMAC-signed (same scheme as the session cookie) and embeds this
-- row's id as its `jti`; this row makes it revocable. Single-user app, so the
-- only scope is the auth.users FK. See apps/web/lib/auth.ts.
CREATE TABLE "mobile_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	"label" text NOT NULL DEFAULT 'Mobile device',
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "mobile_tokens_user_idx" ON "mobile_tokens" ("user_id");
