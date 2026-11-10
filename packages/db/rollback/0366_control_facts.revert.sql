-- Rollback of 0366_control_facts: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- The older image works with 0366 in place and never reads the two new
-- columns of control_boxes. They hold no secret, so this revert keeps them
-- and their values, and takes 0366 off the ledger, so the next roll forward
-- runs it again (every statement in 0366 is re-runnable). On a box that is
-- not a CC the table is empty and it only moves the ledger.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0366_control_facts.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791850000000;
