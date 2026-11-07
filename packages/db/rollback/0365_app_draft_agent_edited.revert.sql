-- Rollback of 0365_app_draft_agent_edited: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It drops apps.draft_agent_edited (the older image neither reads nor
-- writes it) and takes 0365 off the ledger, so the next roll forward runs
-- it again. A draft an agent edited is then a draft like any other: the
-- older image's broker runs its calls, as it did before 0365.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0365_app_draft_agent_edited.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."apps" DROP COLUMN IF EXISTS "draft_agent_edited";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791583503000;
