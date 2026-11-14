-- Rollback of 0374_pipeline_run_trace_kind: what an operator MAY run before
-- pinning the image one release back. Not a migration: nothing runs it on
-- its own.
--
-- `ALTER TYPE ... ADD VALUE` is not reversible (0202 says why), and nothing
-- has to be undone: an unused enum value costs nothing, and the older image
-- never writes a trace of kind 'pipeline_run' (it reads the kinds it has as
-- text). This revert only takes 0374 off the ledger, so the next roll
-- forward runs it again (ADD VALUE IF NOT EXISTS: a no-op then).
--
--   docker exec mantle_web cat /app/packages/db/rollback/0374_pipeline_run_trace_kind.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792030000000;
