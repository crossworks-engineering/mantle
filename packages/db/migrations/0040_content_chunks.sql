-- Derived per-node retrieval chunks (Phase 4: chunked retrieval). A long doc
-- in one embedding searches poorly; chunking by section + embedding each piece
-- lets retrieval find the right part. Rebuilt by the extractor on every
-- (re)index (delete-for-node then re-insert), so rows never accumulate.

CREATE TABLE IF NOT EXISTS "content_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading_path" text,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_node_idx" ON "content_chunks" ("node_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_owner_idx" ON "content_chunks" ("owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_embedding_idx" ON "content_chunks" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
