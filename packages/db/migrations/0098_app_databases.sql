-- Per-app SQLite registry. Each app gets its own durable SQLite database,
-- brokered server-side: the sandboxed iframe issues SQL over the postMessage
-- bridge → the host opens ONLY the file named in this app's row → runs it. One
-- file per app (unique on app_node_id); cascades when the app node is deleted.
-- `storage_path` is a server-local volume path (MVP) — see
-- packages/content/src/app-broker.ts. `schema_version` tracks how far the app's
-- declared DDL (manifest.sqlite.schemaSql) has been applied.

CREATE TABLE IF NOT EXISTS "app_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"app_node_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"schema_version" integer DEFAULT 0 NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_databases" ADD CONSTRAINT "app_databases_app_node_id_nodes_id_fk" FOREIGN KEY ("app_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "app_databases_app_uq" ON "app_databases" USING btree ("app_node_id");
--> statement-breakpoint
CREATE INDEX "app_databases_owner_idx" ON "app_databases" USING btree ("owner_id");
