-- M1: SharePoint / OneDrive sync. ms_drives = a drive (OneDrive or SharePoint
-- document library) the connected account can see; opt-in (enabled=false until
-- chosen), with the Graph delta cursor per drive. ms_drive_items = provenance +
-- dedup map from a Graph driveItem to the `file` node holding its bytes (synced
-- files are ordinary file nodes so the existing extractor handles them). See
-- docs/microsoft-graph-ingest.md.
CREATE TABLE "ms_drives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "ms_accounts"("id") ON DELETE CASCADE,
	"drive_id" text NOT NULL,
	"drive_type" text NOT NULL,
	"name" text NOT NULL,
	"site_name" text,
	"web_url" text,
	"branch_label" text NOT NULL,
	"enabled" boolean NOT NULL DEFAULT false,
	"delta_link" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "ms_drives_account_idx" ON "ms_drives" ("account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ms_drives_account_drive_uq" ON "ms_drives" ("account_id","drive_id");
--> statement-breakpoint
CREATE TABLE "ms_drive_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "ms_accounts"("id") ON DELETE CASCADE,
	"drive_db_id" uuid NOT NULL REFERENCES "ms_drives"("id") ON DELETE CASCADE,
	"node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE RESTRICT,
	"item_id" text NOT NULL,
	"etag" text,
	"web_url" text,
	"node_path" text,
	"last_modified" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "ms_drive_items_drive_idx" ON "ms_drive_items" ("drive_db_id");
--> statement-breakpoint
CREATE INDEX "ms_drive_items_node_idx" ON "ms_drive_items" ("node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ms_drive_items_drive_item_uq" ON "ms_drive_items" ("drive_db_id","item_id");
