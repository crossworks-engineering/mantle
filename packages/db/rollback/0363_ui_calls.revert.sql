-- Rollback of 0363_ui_calls: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image works with 0363 in place. It never reads or
-- writes `ui_calls`, and the older migrate's grants leave a table its access
-- matrix does not list closed to the workspace role (the role's grants are
-- made from the matrix, never by default). So this revert keeps the table,
-- its rows, indexes and row rule: it only takes 0363 off the ledger, so the
-- next roll forward runs it again (every statement in 0363 is IF NOT
-- EXISTS, or drops and makes its policy again).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0363_ui_calls.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791583383000;
