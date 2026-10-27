-- Rollback of 0335_messenger: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image works with 0335 in place. It never reads the
-- messenger tables or login_presence, and the two push_login_prefs columns
-- have defaults it never writes. So this revert keeps every chat: it only
-- takes 0335 off the ledger, so the next roll forward runs it again (every
-- statement in 0335 is IF NOT EXISTS, DROP ... IF EXISTS then CREATE, or
-- CREATE OR REPLACE, so it keeps the tables and their rows as they are).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0335_messenger.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then 0334's revert, then pin the older image straight away
-- (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200260000;
