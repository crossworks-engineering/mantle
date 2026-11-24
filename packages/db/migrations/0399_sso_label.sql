-- Company sign-in's button label set from the screens (docs/oidc-sign-in.md,
-- "Settings"; docs/control-center.md):
--  - sso_setup.label: the word of the sign-in button ("Sign in with
--    {label}"), set on the box's setup screen or from a Control Center, in
--    any mode but off. Null: none (the default, "Single sign-on"). A
--    MANTLE_OIDC_LABEL line in the box .env wins. The app holds it to one
--    pattern before it is stored (@mantle/client-types sso-label.ts); the
--    check here is a length belt only. Public: the sign-in screen shows it
--    to anyone. Each process that reads the sign-in settings reads it at
--    boot and every 60 seconds. Read and written at the full-route spot
--    oidc-link only, as the rest of the row.
--
-- Additive, no trigger, no LLM work, no change to existing rows. Re-runnable.
-- Revert: packages/db/rollback/0399_sso_label.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
LOCK TABLE "public"."sso_setup" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."sso_setup" ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
ALTER TABLE "public"."sso_setup" DROP CONSTRAINT IF EXISTS "sso_setup_label_check";
--> statement-breakpoint
ALTER TABLE "public"."sso_setup" ADD CONSTRAINT "sso_setup_label_check"
  CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 60);
