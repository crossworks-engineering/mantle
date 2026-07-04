-- Team-member tokens for contacts.
--
-- A live row = the contact holds the "team member" role (no duplicate flag on
-- the node — single source of truth). Stores only the SHA-256 of the short
-- token handed to the contact; plaintext is shown once at mint. Consumed by
-- the /s/ app-share surface (Phase B) to identify which team member is using
-- a shared app.

CREATE TABLE IF NOT EXISTS "contact_team_tokens" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"     uuid NOT NULL,
  "contact_id"   uuid NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "token_hash"   text NOT NULL,
  "last_used_at" timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_team_tokens_contact_idx" ON "contact_team_tokens" ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_team_tokens_hash_idx" ON "contact_team_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_team_tokens_owner_idx" ON "contact_team_tokens" ("owner_id");
