-- Rollback of 0398_translator_lab_models: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional, and it leaves the data as it is: the older image runs the
-- Translator on these models as well (a model id is data to it), and moving
-- the rows back would send text to third-party hosts again. This only takes
-- 0398 off the ledger, so the next roll forward applies it again (a no-op on
-- rows it moved already).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0398_translator_lab_models.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792340240000;
