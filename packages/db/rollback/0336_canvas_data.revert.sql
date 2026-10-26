-- Rollback of 0336_canvas_data: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image works with 0336 in place. It never reads
-- `canvas_data`, and its canvases never call `mantle.data`. So this revert
-- keeps every stored value: it only takes 0336 off the ledger, so the next
-- roll forward runs it again (every statement in 0336 is IF NOT EXISTS or
-- drops and makes its policy again, so the table and its rows stay as they
-- are).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0336_canvas_data.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200260000;
