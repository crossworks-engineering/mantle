-- Member invites (member logins, Phase 6). An admin invites a person by a
-- code; the person opens the invite link, sets a password, and becomes a
-- MEMBER login (auth.users role member). An old 8-char team code works once
-- in place of the invite code, while its contact has an open invite; the
-- redeem deletes that team code. See packages/content/src/member-invites.ts
-- and docs/member-logins.md "Invites".
--
-- Modelled on pairing_codes (0157): only the SHA-256 of the code is stored,
-- single use (redeemed_at set once under a row lock), time-limited
-- (expires_at, 72 hours). owner_id is the brain anchor, like
-- contact_team_tokens. A new table only: metadata, cheap on a live database.

CREATE TABLE IF NOT EXISTS "member_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"contact_id" uuid REFERENCES "nodes"("id") ON DELETE SET NULL,
	"email" text NOT NULL,
	"display_name" text,
	"code_hash" text NOT NULL UNIQUE,
	"created_by" uuid REFERENCES auth.users(id) ON DELETE SET NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_login_id" uuid REFERENCES auth.users(id) ON DELETE SET NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_invites_owner_idx" ON "member_invites" ("owner_id", "created_at" DESC);
--> statement-breakpoint
-- One open invite per contact. "Open" cannot mention now(), so an expired
-- invite still holds the slot: creating a new invite revokes the old one
-- first, in the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS "member_invites_open_contact_idx"
  ON "member_invites" ("contact_id")
  WHERE "redeemed_at" IS NULL AND "revoked_at" IS NULL;
