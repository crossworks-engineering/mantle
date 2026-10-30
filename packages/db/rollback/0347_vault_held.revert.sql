-- Rollback of 0347_vault_held: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image names no `held_enc` and writes keys as before.
-- This revert clears every waiting change (the sealed values of replaces
-- that were never approved: the MCP client asks again after the roll
-- forward), keeps the column, and takes 0347 off the ledger, so the next
-- roll forward runs it again (its statement is IF NOT EXISTS).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0347_vault_held.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."api_keys" SET "held_enc" = NULL WHERE "held_enc" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790287320000;
