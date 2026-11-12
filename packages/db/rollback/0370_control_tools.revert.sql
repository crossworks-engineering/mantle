-- Rollback of 0370_control_tools: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- The older image works with 0370 in place and never reads the new column
-- of control_boxes. It may hold sealed tool args and their answers, so this
-- revert clears it (the calls are gone; send them again after the roll
-- forward), keeps the column, and takes 0370 off the ledger, so the next
-- roll forward runs it again (0370 is re-runnable). On a box that is not a
-- CC the table is empty and it only moves the ledger.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0370_control_tools.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."control_boxes" SET "tool_job" = NULL WHERE "tool_job" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791970000000;
