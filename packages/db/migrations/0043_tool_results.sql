-- Ephemeral spill store for oversized tool results — the "L6" of the tool-loop.
-- A large tool result (a child agent's synthesis, a big file_read, a wide
-- search) is stored here instead of being crammed into the conversation; the
-- model gets a handle + preview and dereferences on demand via `read_result`
-- (page / grep / semantic query). NOT a nodes row — transient working state,
-- never reaches the extractor or brain search. TTL-cleaned by age.
-- See docs/architecture.md §9l.

CREATE TABLE IF NOT EXISTS "tool_results" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"trace_id" uuid,
	"tool_slug" text NOT NULL,
	"content" text NOT NULL,
	"bytes" integer NOT NULL,
	"chunked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_result_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_result_chunks" ADD CONSTRAINT "tool_result_chunks_result_id_tool_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."tool_results"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_results_owner_created_idx" ON "tool_results" USING btree ("owner_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_result_chunks_result_idx" ON "tool_result_chunks" USING btree ("result_id");
