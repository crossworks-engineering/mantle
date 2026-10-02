-- This brain's own stable id (multi-login Phase 3, push routing;
-- docs/mobile-companion-backend.md, "Push routing on a device with several
-- logins").
--
-- A phone or a desktop may hold logins on several brains, with one OS push
-- token for all of them. Every push payload and GET /api/auth/whoami name
-- this id, so the app can tell which brain a push is from and open the right
-- session. A random uuid: it reveals nothing (not the address, not the
-- owner, no secret). Written once, here; the code only reads it, so it holds
-- across restarts and upgrades.
--
-- One row, made by this migration. Plain DDL and one insert, no trigger, no
-- job. Idempotent: a second run keeps the id the first one made.
CREATE TABLE IF NOT EXISTS "public"."brain_identity" (
  "singleton"  boolean PRIMARY KEY DEFAULT true NOT NULL,
  "brain_id"   uuid NOT NULL DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "brain_identity_singleton_ck" CHECK ("singleton")
);
--> statement-breakpoint
INSERT INTO "public"."brain_identity" ("singleton") VALUES (true)
ON CONFLICT ("singleton") DO NOTHING;
