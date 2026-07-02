-- Multi-admin users + audit trail.
--
-- Mantle stays a single-brain system: all content remains keyed to the ANCHOR
-- account (the original user, is_owner = true). Additional auth.users rows are
-- co-admin LOGINS into that same brain — an identity for the audit trail and a
-- per-user read_only flag, never a data scope.
--
-- IF NOT EXISTS throughout: fresh installs get these columns from
-- infra/postgres/init/02-auth-schema.sql before migrations replay.

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS display_name text;--> statement-breakpoint
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;--> statement-breakpoint
-- Backfill: the oldest existing account becomes the anchor (no-op on fresh installs,
-- where signup sets is_owner directly).
UPDATE auth.users SET is_owner = true
  WHERE id = (SELECT id FROM auth.users ORDER BY created_at ASC LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM auth.users WHERE is_owner);--> statement-breakpoint
-- At most one anchor, ever.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner_idx ON auth.users (is_owner) WHERE is_owner;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id"    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  "actor_email" text NOT NULL,
  "action"      text NOT NULL,
  "method"      text,
  "path"        text,
  "ip"          text,
  "user_agent"  text,
  "detail"      jsonb,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_idx" ON "audit_log" ("created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_idx" ON "audit_log" ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log" ("action");
