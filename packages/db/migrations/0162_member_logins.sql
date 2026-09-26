-- Member logins, Phase 1 (plan section 3): a login is an admin or a member.
-- The anchor (is_owner) is always an admin. A member is refused by every admin
-- gate and reaches only the member routes, which run at the team level (RLS).
-- The role is read from this row on every request, never from a token.
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'admin';
--> statement-breakpoint
-- The team contact this login belongs to (its name, its team token history).
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "contact_id" uuid;
--> statement-breakpoint
-- A disabled login cannot sign in, refresh a token, or use a session it holds.
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "disabled_at" timestamptz;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_ck') THEN
    ALTER TABLE "auth"."users" ADD CONSTRAINT "users_role_ck"
      CHECK ("role" IN ('admin', 'member') AND (NOT "is_owner" OR "role" = 'admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_contact_fk') THEN
    ALTER TABLE "auth"."users" ADD CONSTRAINT "users_contact_fk"
      FOREIGN KEY ("contact_id") REFERENCES "public"."nodes"("id") ON DELETE SET NULL;
  END IF;
END
$$;
