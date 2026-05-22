-- Pages sidecar. One row per page node holding the TipTap/ProseMirror
-- document (`doc`, source of truth) and a derived plaintext rendering
-- (`doc_text`) that the extractor + FTS read. Page-level metadata (icon,
-- summary, visibility) stays on the parent `nodes` row so tree/index scans
-- stay lean — same split as `emails` / `secrets`.

CREATE TABLE IF NOT EXISTS "pages" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"doc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"doc_text" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
