-- A file synced from OneDrive can be deleted again (Sync plan M4, page
-- f11288e3). `ms_drive_items.node_id` was ON DELETE RESTRICT (0102): the
-- mapping held its file node until the Microsoft account's own delete
-- cascaded the mapping away. M4 removed that account delete with the rest of
-- the old Microsoft sync, so a file with a mapping row could never be
-- deleted (the FK raised 23503, a 500 to the caller, and a folder delete
-- holding one failed as a whole). The runtime role holds no grant on the
-- table, so the file delete cannot remove the row itself.
--
-- The row is provenance only (where the bytes came from in a drive). It now
-- goes with its file node. The table, its rows and every other FK stay as
-- they are; the M2/M3 Sync service reads what is left. No new grant, no
-- trigger, no rewrite of the table. Re-runnable.
-- Revert: packages/db/rollback/0378_ms_drive_items_node_cascade.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."ms_drive_items" DROP CONSTRAINT IF EXISTS "ms_drive_items_node_id_fkey";
--> statement-breakpoint
ALTER TABLE "public"."ms_drive_items" ADD CONSTRAINT "ms_drive_items_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE CASCADE;
