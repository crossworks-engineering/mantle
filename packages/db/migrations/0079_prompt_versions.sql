-- Agent Studio Phase 2 (docs/agent-studio.md): prose version history.
--
-- Append-only history for human-editable prompt fields (agent.system_prompt,
-- skill.instructions, worker.system_prompt / params.extraction_prompt). One row
-- per saved version; (entity_type, entity_id, field) keys the prose and `version`
-- is monotonic within it (v1 = the original snapshot, captured lazily on first
-- edit). Every edit AND every revert appends a row — nothing is overwritten, so a
-- live prompt is always one revert away. Polymorphic entity_id (agents / skills /
-- ai_workers) → no FK. trace_id reserved for Phase 4.

CREATE TABLE "prompt_versions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"    uuid NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id"   uuid NOT NULL,
  "field"       text NOT NULL,
  "version"     integer NOT NULL,
  "body"        text NOT NULL,
  "note"        text,
  "author"      uuid,
  "trace_id"    uuid,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_key_version_uq" ON "prompt_versions" USING btree ("entity_type","entity_id","field","version");
--> statement-breakpoint
CREATE INDEX "prompt_versions_key_idx" ON "prompt_versions" USING btree ("entity_type","entity_id","field");
--> statement-breakpoint
CREATE INDEX "prompt_versions_owner_idx" ON "prompt_versions" USING btree ("owner_id");
