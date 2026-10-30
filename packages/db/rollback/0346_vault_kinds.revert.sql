-- Rollback of 0346_vault_kinds: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- The older image runs with 0346's columns in place: it names none of them,
-- and an insert takes their defaults (a token, no target, no fields). What
-- it must not see is a secret of another kind: it opens every row as a
-- token, so a password, an SSH key or a login could be templated into an
-- HTTP tool's request. So this DELETES every row whose kind is not 'token'
-- (the owner adds them again after the roll forward; their values are not
-- kept anywhere else). The columns, the checks and the index stay: 0346 is
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
