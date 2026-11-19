-- Rollback of 0389_ai_worker_kind_translator: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image rollback).
-- Not a migration: nothing runs it on its own.
--
-- Optional: Postgres cannot drop an enum value, and the older image never
-- reads or writes a `translator` row, so the value may stay. This removes the
-- Translator workers the newer image seeded (the older image's worker screen
-- does not know the kind) and takes 0389 off the ledger, so the next roll
-- forward applies it again (ADD VALUE IF NOT EXISTS: a no-op) and the boot
-- reconcile seeds the worker again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0389_ai_worker_kind_translator.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "public"."ai_workers" WHERE "kind" = 'translator';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792280000000;
