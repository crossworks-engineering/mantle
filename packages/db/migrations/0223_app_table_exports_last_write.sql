-- Apps audit 2026-10-02, item 7 (the D8 hole). `dirty_since` keeps the FIRST
-- write of a burst, so a write that landed while a sync ran kept that old
-- stamp, and the sync cleared it with its own: lost on a restart. Every app
-- write now stamps `last_write_at` too, and a sync clears the dirty mark only
-- when no write came after it read the rows
-- (packages/content/src/app-table-exports.ts). Additive.
ALTER TABLE "public"."app_table_exports" ADD COLUMN IF NOT EXISTS "last_write_at" timestamptz;
