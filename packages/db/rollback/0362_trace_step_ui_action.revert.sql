-- Rollback of 0362_trace_step_ui_action: what an operator MAY run before
-- pinning the image one release back, after 0363's revert. Not a
-- migration: nothing runs it on its own.
--
-- `ALTER TYPE ... ADD VALUE` is not reversible (0202 says why), and nothing
-- has to be undone: an unused enum value costs nothing, and the older image
-- never writes a step of kind 'ui_action' (it reads the steps it has as
-- text). This revert only takes 0362 off the ledger, so the next roll
-- forward runs it again (ADD VALUE IF NOT EXISTS: a no-op then).
--
--   docker exec mantle_web cat /app/packages/db/rollback/0362_trace_step_ui_action.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791583323000;
