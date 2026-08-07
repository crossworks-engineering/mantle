-- Draws sidecar. One row per draw node holding the Excalidraw scene
-- (`scene`, source of truth: { elements, appState? }) plus a derived
-- plaintext rendering (`scene_text`) that the extractor + FTS read, and an
-- SVG snapshot (`scene_svg`) captured client-side at commit that every
-- non-editor surface renders (list preview, /s share, email, docx, PDF).
-- Draw-level metadata (summary, visibility) stays on the parent `nodes`
-- row so tree/index scans stay lean — same split as `pages` / `tables`.
--
-- `file_refs` maps Excalidraw BinaryFile ids -> `file` node ids: pasted
-- images live in the files pipeline (uploaded once, OCR'd once), never as
-- dataURLs inside the scene blob.
--
-- Draft model mirrors pages exactly: `draft_scene` is the autosaved working
-- copy (null when nothing uncommitted), promoted into `scene` on commit;
-- `draft_rev` is the optimistic-concurrency etag bumped on every draft
-- write, commit, and discard.

CREATE TABLE IF NOT EXISTS "draws" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"scene" jsonb DEFAULT '{"elements":[]}'::jsonb NOT NULL,
	"scene_text" text DEFAULT '' NOT NULL,
	"scene_svg" text,
	"file_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_scene" jsonb,
	"draft_updated_at" timestamp with time zone,
	"draft_rev" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draws" ADD CONSTRAINT "draws_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
