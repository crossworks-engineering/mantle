-- OAuth (remote MCP connector) grants carry the LOGIN that consented, not only
-- the anchor the brain is keyed to. Before this, a connector minted by a second
-- admin kept working after that login was demoted to member, disabled or
-- deleted: the rows named only the anchor, and the bearer check never looked
-- at a login. Now the bearer check, the code exchange and every refresh re-read
-- the actor's row (an admin, not disabled), lockout revokes by actor, and
-- deleting a login deletes its grants (FK cascade).
--
-- Backfill: existing rows get the anchor (owner_id), the only login a row can
-- be attributed to. A connector a second admin made before this release stays
-- the anchor's; disconnect it in Settings if that admin is locked out.
ALTER TABLE "oauth_auth_codes" ADD COLUMN IF NOT EXISTS "actor_id" uuid;
--> statement-breakpoint
UPDATE "oauth_auth_codes" SET "actor_id" = "owner_id" WHERE "actor_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ALTER COLUMN "actor_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "actor_id" uuid;
--> statement-breakpoint
UPDATE "oauth_access_tokens" SET "actor_id" = "owner_id" WHERE "actor_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ALTER COLUMN "actor_id" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_auth_codes_actor_fk') THEN
    ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_actor_fk"
      FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_access_tokens_actor_fk') THEN
    ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_actor_fk"
      FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_actor_idx" ON "oauth_access_tokens" ("actor_id");
