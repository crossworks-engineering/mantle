-- Rollback of 0347_must_change_password: what an operator MUST run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Required: the older image works with 0347's columns in place (it never
-- reads or writes must_change_password or password_checked_min; an insert
-- takes their defaults, false and null), but it writes a new password with
-- no checked rule. So this revert clears every login's checked rule and
-- flag (below): when 0347's image comes back, every login signs in once
-- and is checked again. A login the newer image held is NOT held by the
-- older image (it has no such gate). The columns stay. The provider alerts
-- of subject model_policy are deleted and the subject CHECK narrowed back
-- to 0230's (the older image's alert list knows only embedding and
-- extraction). Then it takes 0347 off the ledger, so the next roll forward
-- runs it again (ADD COLUMN IF NOT EXISTS keeps the columns; the CHECK is
-- dropped and made again).
--
-- Copy it out, stop the web container (no model_policy alert may be written
-- between the delete and the narrowed CHECK), run it as the superuser in one
-- transaction, then pin the older image straight away (docs/update-prod.md
-- "Rollback"):
--   docker exec mantle_web cat /app/packages/db/rollback/0347_must_change_password.revert.sql > 0347.revert.sql
--   docker stop mantle_web
--   docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 < 0347.revert.sql
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- The older image writes only the hash with a new password, so a password
-- set while it runs would read as checked when 0347 comes back. Forget
-- every check: the roll forward has each login sign in once under the rule.
UPDATE "auth"."users" SET "password_checked_min" = NULL, "must_change_password" = false;
--> statement-breakpoint
DELETE FROM "public"."provider_alerts" WHERE "subject" = 'model_policy';
--> statement-breakpoint
ALTER TABLE "public"."provider_alerts" DROP CONSTRAINT IF EXISTS "provider_alerts_subject_check";
--> statement-breakpoint
ALTER TABLE "public"."provider_alerts"
  ADD CONSTRAINT "provider_alerts_subject_check"
  CHECK ("subject" IN ('embedding', 'extraction'));
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790373660000;
