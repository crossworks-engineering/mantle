-- App table exports — a brain Table as a DERIVED, read-only view of one table
-- inside an app's own SQLite database. The app is the master: after an app
-- write the platform re-materializes the Table from the SQLite rows (pure SQL,
-- no LLM), so the assistant, table views and shares see live app data. While a
-- link row exists the Table refuses every grid edit from the Tables side
-- (rows, cells, columns, tabs, delete); metadata stays owner-editable.
--
-- `content_hash` short-circuits a re-materialize whose rows didn't change —
-- a chatty app must not become commit/extractor churn (cost-safety). Both FKs
-- cascade so deleting either end dissolves the link; a table orphaned by app
-- deletion becomes an ordinary editable table again.

CREATE TABLE IF NOT EXISTS "app_table_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"app_node_id" uuid NOT NULL,
	"sqlite_table" text NOT NULL,
	"table_node_id" uuid NOT NULL,
	"content_hash" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_table_exports" ADD CONSTRAINT "app_table_exports_app_node_id_nodes_id_fk" FOREIGN KEY ("app_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_table_exports" ADD CONSTRAINT "app_table_exports_table_node_id_nodes_id_fk" FOREIGN KEY ("table_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_table_exports_table_uq" ON "app_table_exports" ("table_node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_table_exports_app_table_uq" ON "app_table_exports" ("app_node_id","sqlite_table");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_table_exports_owner_idx" ON "app_table_exports" ("owner_id");
