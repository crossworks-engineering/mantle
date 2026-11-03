-- Rollback of 0353_provider_alerts_decision: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It deletes the decider's alert rows, puts back 0348's subject check, and
-- takes 0353 off the ledger, so the next roll forward runs it again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0353_provider_alerts_decision.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "public"."provider_alerts" WHERE "subject" = 'decision';
--> statement-breakpoint
ALTER TABLE "public"."provider_alerts" DROP CONSTRAINT IF EXISTS "provider_alerts_subject_check";
--> statement-breakpoint
ALTER TABLE "public"."provider_alerts"
  ADD CONSTRAINT "provider_alerts_subject_check"
  CHECK ("subject" IN ('embedding', 'extraction', 'model_policy'));
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790892060000;
