-- Rollback of 0346_vault_kinds: what an operator runs before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback;
-- docs/update-prod.md "Going up to 0346"). Not a migration: nothing runs it
-- on its own.
--
-- The older image runs with 0346's columns in place: it names none of them,
-- and an insert takes their defaults (a token, no target, no fields). A
-- secret of another kind it cannot open (its value is sealed with
-- `<id>:<kind>`, the older image opens with the row id only), but it would
-- list one as a key and could pick one as a provider's key and fail. So
-- this DELETES every row whose kind is not 'token' (the owner adds them
-- again after the roll forward; their values are not kept anywhere else). The columns, the checks and the index stay: 0346 is
-- re-runnable, so the next roll forward applies it again over them. Then it
-- takes 0346 off the ledger.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0346_vault_kinds.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "public"."api_keys" WHERE "kind" <> 'token';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790287260000;
