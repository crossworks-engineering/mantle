-- Rollback of 0331_node_type_present: what an operator MAY run before
-- pinning the image one release back, after 0332's revert. Not a
-- migration: nothing runs it on its own.
--
-- `ALTER TYPE ... ADD VALUE` is not reversible (0202 says why), and nothing
-- has to be undone: an unused enum value costs nothing, and the older image
-- never writes or reads a node of type 'present'. This revert only takes
-- 0331 off the ledger, so the next roll forward runs it again (ADD VALUE IF
-- NOT EXISTS: a no-op then).
--
--   docker exec mantle_web cat /app/packages/db/rollback/0331_node_type_present.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200020000;
