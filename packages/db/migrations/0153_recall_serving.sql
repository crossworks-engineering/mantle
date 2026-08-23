-- Recall S1: the serving layer behind the memory-map system.
-- Pages author it (a tree whose root carries the `recall` tag = a map, a page
-- tagged `prompt` = a prompt); commitPage COMPILES that tree into these rows
-- so every agent-facing read is one indexed row. Rows are a build artifact —
-- the compiler upserts on commit, deletes on untag/delete, and keeps the last
-- good rev serving when a commit fails lint (report in last_compile_report).
-- Design: "Recall — architecture plan v1" (dev brain), roadmap task 97cf7850.
CREATE TABLE IF NOT EXISTS "recall_maps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"enter_when" text DEFAULT '' NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"last_compile_ok" boolean DEFAULT true NOT NULL,
	"last_compile_report" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recall_maps_owner_slug_uq" ON "recall_maps" ("owner_id","slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recall_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"map_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"body_chars" integer DEFAULT 0 NOT NULL,
	"use_when" text DEFAULT '' NOT NULL,
	"options" jsonb,
	"embedding" vector(768),
	"source_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recall_nodes_map_slug_uq" ON "recall_nodes" ("map_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recall_nodes_owner_kind_idx" ON "recall_nodes" ("owner_id","kind");
--> statement-breakpoint
-- Partial ANN index for recall_match: only prompt rows carry vectors, so the
-- index holds exactly the matchable set. ivfflat per repo convention; lists
-- is small because prompt pools are (tens, not thousands).
CREATE INDEX IF NOT EXISTS "recall_nodes_prompt_embedding_idx"
  ON "recall_nodes" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 10)
  WHERE "kind" = 'prompt';
