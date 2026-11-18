-- The Sync service's file map (Sync service plan M3, page f11288e3): one row
-- per file a drive sync placed in the brain, from the outside item (service,
-- source = the drive, item id) to its file node. The sidecar compares a
-- drive's listing with it: an item with the same provider hash is not
-- fetched again, an item gone from the listing leaves the brain. It replaces
-- ms_drive_items (0102), whose rows the copy task (sync-copy-accounts) moves
-- here under the same drive ids; the old table stays until the later drop.
--
-- The row is provenance only: it goes with its file node (ON DELETE
-- CASCADE, as 0379 made the old map). Read and written only by the brain's
-- sidecar routes (/api/sidecar/files, the service's own token) on the system
-- pool, outside every scope: the runtime role holds no right on it
-- (access-matrix.ts). Additive, no rewrite, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0382_sync_items.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."sync_items" (
  "service" text NOT NULL,
  "source" text NOT NULL,
  "item_id" text NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "hash" text,
  "size" bigint,
  "mod_time" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("service", "source", "item_id"),
  CONSTRAINT "sync_items_service_ck" CHECK ("service" ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT "sync_items_source_ck" CHECK (length("source") BETWEEN 1 AND 200),
  CONSTRAINT "sync_items_item_ck" CHECK (length("item_id") BETWEEN 1 AND 400),
  CONSTRAINT "sync_items_hash_ck" CHECK ("hash" IS NULL OR length("hash") <= 200)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_items_node_idx" ON "public"."sync_items" ("node_id");
