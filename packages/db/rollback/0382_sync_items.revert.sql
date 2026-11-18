-- Rollback of 0382_sync_items: what an operator MAY run before pinning the
-- image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image works with 0382 in place. It never reads or
-- writes `sync_items`, and the older migrate's grants leave a table its
-- access matrix does not list closed to the runtime roles. Dropping the
-- table loses only the map from each synced file to its drive item: the
-- files stay, and the next drive run fetches each item once more (equal
-- bytes keep their node).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0382_sync_items.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."sync_items";
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792130000000;
