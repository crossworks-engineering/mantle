-- Company sign-in's mode raised from the Control Center (docs/oidc-sign-in.md,
-- "From the Control Center"; docs/control-center.md):
--  - sso_setup.mode: setup, optional or required, raised by a Control Center
--    one step at a time (off, setup, optional, required), never down. Null is
--    off. Read only while the box .env has no MANTLE_OIDC_MODE line: a .env
--    line wins, and is the only way down. Each process that reads the
--    sign-in settings reads it at boot and every 60 seconds. Not secret.
--    Read and written at the full-route spot oidc-link only, as the rest of
--    the row.
--
-- Additive, no trigger, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0372_sso_mode_from_cc.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
LOCK TABLE "public"."sso_setup" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."sso_setup" ADD COLUMN IF NOT EXISTS "mode" text;
--> statement-breakpoint
ALTER TABLE "public"."sso_setup" DROP CONSTRAINT IF EXISTS "sso_setup_mode_check";
--> statement-breakpoint
ALTER TABLE "public"."sso_setup" ADD CONSTRAINT "sso_setup_mode_check"
  CHECK ("mode" IS NULL OR "mode" IN ('setup', 'optional', 'required'));
