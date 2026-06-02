-- Tables sidecar: one row per `nodes` row of type='table'. Holds the typed
-- grid document (`data` = TableDoc JSON), its derived markdown rendering
-- (`data_text`, read by the extractor + FTS), and an autosaved working copy
-- (`draft_data`, promoted into `data` on commit). Mirrors the `pages` sidecar.
-- FK cascades so deleting the node reaps the grid.

CREATE TABLE IF NOT EXISTS "tables" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_text" text DEFAULT '' NOT NULL,
	"draft_data" jsonb,
	"draft_updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
