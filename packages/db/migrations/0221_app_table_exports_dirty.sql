-- Apps first-class plan, Phase 3 (D8): an app write that feeds a table
-- export marks the export "dirty" here, and a sync that reads the rows
-- clears it. The debounced sync timer lives in one process's memory, so a
-- restart between the write and the sync used to lose the sync until the
-- next write; now the boot and a nightly sweep pick up what is still dirty
-- (packages/content/src/app-table-exports.ts). Additive.
ALTER TABLE "public"."app_table_exports" ADD COLUMN IF NOT EXISTS "dirty_since" timestamptz;
CREATE INDEX IF NOT EXISTS "app_table_exports_dirty_idx" ON "public"."app_table_exports" ("dirty_since") WHERE "dirty_since" IS NOT NULL;
