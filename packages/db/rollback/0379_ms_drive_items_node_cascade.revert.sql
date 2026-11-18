-- Rollback of 0379_ms_drive_items_node_cascade: what an operator runs before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It puts 0102's ON DELETE RESTRICT back on ms_drive_items.node_id and takes
-- 0378 off the ledger, so the next roll forward runs it again. Rows the
-- cascade already removed (with their deleted files) do not come back; they
-- were provenance of files that no longer exist.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0379_ms_drive_items_node_cascade.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."ms_drive_items" DROP CONSTRAINT IF EXISTS "ms_drive_items_node_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."ms_drive_items" ADD CONSTRAINT "ms_drive_items_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792070000000;
