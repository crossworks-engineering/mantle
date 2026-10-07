-- MCP as a login, and peer tokens bound to a login (plan page e5b854dd,
-- 2026-10-03).
--
-- 1. mcp_login_access: the admin's per-login switch. A member or client
--    login reaches /api/mcp only while `enabled` is on, and gets the draft
--    write tools only while `write_enabled` is on. No row = off. Admins do
--    not use it (their connector is unchanged).
-- 2. mcp_login_tokens: static bearer tokens bound to one member or client
--    login, for an MCP client without OAuth. Hashed at rest (SHA-256), shown
--    once. `session_epoch` is the login's epoch at mint: a sign out
--    everywhere, password change, disable or role change ends the token.
-- 3. oauth_auth_codes / oauth_access_tokens.session_epoch: the same epoch
--    rule for a member's or client's OAuth grant. NULL for an admin grant
--    (no epoch check: an admin's connector keeps today's behaviour).
-- 4. mantle_peers: the login a peer token acts as on /api/mcp, the role
--    that login had when it was bound (a role change fails closed), the
--    write switch, and the risky tools the owner allowed by name.
--
-- Plain DDL, no trigger, no job. Idempotent.
CREATE TABLE IF NOT EXISTS "public"."mcp_login_access" (
  "login_id"      uuid PRIMARY KEY NOT NULL,
  "enabled"       boolean NOT NULL DEFAULT false,
  "write_enabled" boolean NOT NULL DEFAULT false,
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_login_access_login_fk"
    FOREIGN KEY ("login_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."mcp_login_tokens" (
  "id"            uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "login_id"      uuid NOT NULL,
  "label"         text NOT NULL DEFAULT 'MCP client',
  "token_hash"    text NOT NULL,
  "session_epoch" integer NOT NULL,
  "created_by"    uuid,
  "last_used_at"  timestamptz,
  "revoked_at"    timestamptz,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_login_tokens_login_fk"
    FOREIGN KEY ("login_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "mcp_login_tokens_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_login_tokens_hash_uq"
  ON "public"."mcp_login_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_login_tokens_login_idx"
  ON "public"."mcp_login_tokens" ("login_id");
--> statement-breakpoint
ALTER TABLE "public"."oauth_auth_codes" ADD COLUMN IF NOT EXISTS "session_epoch" integer;
--> statement-breakpoint
ALTER TABLE "public"."oauth_access_tokens" ADD COLUMN IF NOT EXISTS "session_epoch" integer;
--> statement-breakpoint
ALTER TABLE "public"."mantle_peers" ADD COLUMN IF NOT EXISTS "acts_as_login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."mantle_peers" ADD COLUMN IF NOT EXISTS "acts_as_role" text;
--> statement-breakpoint
ALTER TABLE "public"."mantle_peers" ADD COLUMN IF NOT EXISTS "write_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."mantle_peers" ADD COLUMN IF NOT EXISTS "allowed_risky_tools" text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mantle_peers_acts_as_login_fk') THEN
    ALTER TABLE "public"."mantle_peers"
      ADD CONSTRAINT "mantle_peers_acts_as_login_fk"
      FOREIGN KEY ("acts_as_login_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mantle_peers_acts_as_role_ck') THEN
    ALTER TABLE "public"."mantle_peers"
      ADD CONSTRAINT "mantle_peers_acts_as_role_ck"
      CHECK ("acts_as_role" IS NULL OR "acts_as_role" IN ('admin', 'member', 'client'));
  END IF;
END $$;
