-- Per-drive sync scopes for SharePoint/OneDrive: the user's "choose what to
-- sync" selections. No rows for a drive = whole drive syncs (v1 behaviour).
-- Rows = only files under a selected folder (path prefix) or exactly-selected
-- files sync. Rows CASCADE with the drive.

CREATE TABLE IF NOT EXISTS "ms_drive_scopes" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "drive_db_id" uuid NOT NULL REFERENCES "ms_drives"("id") ON DELETE CASCADE,
  "item_id"     text NOT NULL,
  "path"        text NOT NULL,
  "is_folder"   boolean NOT NULL,
  "name"        text,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ms_drive_scopes_drive_item_uq"
  ON "ms_drive_scopes" ("drive_db_id", "item_id");
