-- Access matrix fixes (L12, L13; audit design choice 1): a peer that acts as
-- a login is unbound when that login's sessions end or its MCP is switched
-- off. These two columns remember the binding that ended, so binding the
-- peer to that same login again restores its Write switch and its allowed
-- risky tools in one step (lib/peer-unbind.ts, setPeerAccess). They are
-- never read to grant anything: a peer acts only through acts_as_login_id.
--
-- Rollback: the previous release never reads them; drop the columns.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."mantle_peers" ADD COLUMN IF NOT EXISTS "ended_acts_as_login_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."mantle_peers" ADD COLUMN IF NOT EXISTS "ended_acts_as_role" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mantle_peers_ended_acts_as_login_fk') THEN
    ALTER TABLE "public"."mantle_peers"
      ADD CONSTRAINT "mantle_peers_ended_acts_as_login_fk"
      FOREIGN KEY ("ended_acts_as_login_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mantle_peers_ended_acts_as_role_ck') THEN
    ALTER TABLE "public"."mantle_peers"
      ADD CONSTRAINT "mantle_peers_ended_acts_as_role_ck"
      CHECK ("ended_acts_as_role" IS NULL OR "ended_acts_as_role" IN ('admin', 'member', 'client'));
  END IF;
END $$;
