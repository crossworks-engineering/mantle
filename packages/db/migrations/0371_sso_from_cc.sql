-- Company sign-in set up from the Control Center (docs/oidc-sign-in.md,
-- docs/control-center.md "The admin channel"):
--  - sso_setup.issuer, sso_setup.client_id: the issuer and the client id a
--    Control Center staged while the box's mode word was setup. Each process
--    that reads the sign-in settings reads them once at boot; a .env line
--    wins over the row. Not secret. Read and written at the full-route spot
--    oidc-link only, as the rest of the row.
--  - control_boxes.sso_view: on a Control Center only, the last answer each
--    box gave to the sign-in cases (status, the last Test code, who set what
--    and when). Never a value of the secret. Written through the CC store's
--    one gateway, at the full-route spot control-center.
--
-- Additive, no trigger, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0371_sso_from_cc.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
LOCK TABLE "public"."sso_setup", "public"."control_boxes" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."sso_setup" ADD COLUMN IF NOT EXISTS "issuer" text;
--> statement-breakpoint
ALTER TABLE "public"."sso_setup" ADD COLUMN IF NOT EXISTS "client_id" text;
--> statement-breakpoint
ALTER TABLE "public"."control_boxes" ADD COLUMN IF NOT EXISTS "sso_view" jsonb;
