-- Apps sidecar. One row per app node holding the app's source (a small virtual
-- file tree), its manifest (declared api_tool slugs + sqlite schema), and
-- pointers to the last esbuild bundle of the draft + published source. App-level
-- metadata (icon, summary, visibility) stays on the parent `nodes` row — same
-- split as `pages` / `tables`.
--
--   source           { entry, files: { path: tsx } }  published (built + run)
--   source_text      concatenated source (extractor + FTS read this)
--   draft_source     autosaved working copy (null = no uncommitted edits)
--   manifest         { toolSlugs[], sqlite?: { schemaSql, schemaVersion }, description? }
--   draft_build      BuildRef of the last bundle of the draft (preview)
--   published_build  BuildRef promoted on publish (go-live artifact)

CREATE TABLE IF NOT EXISTS "apps" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"source" jsonb DEFAULT '{"entry":"App.tsx","files":{}}'::jsonb NOT NULL,
	"source_text" text DEFAULT '' NOT NULL,
	"draft_source" jsonb,
	"draft_updated_at" timestamp with time zone,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_build" jsonb,
	"published_build" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
