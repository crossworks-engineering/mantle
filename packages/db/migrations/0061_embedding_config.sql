-- 0061: embedding_config — THE single source of truth for the brain's embedder.
--
-- Collapses every prior override point into ONE row per owner: the `embedding`
-- ai-worker kind, the MANTLE_EMBEDDING_MODEL env, per-agent
-- memory_config.embedding_model, the extractor's params.embedding_model, and
-- per-call opts.model. After this migration nothing else may choose an embedder.
--
-- The brain is vector-space-locked: every stored vector must come from the SAME
-- model. So there is exactly one `model` + one `dimensions`. `primary` and
-- `backup` are two ROUTES to that same model (a different host/provider for
-- availability) — never a different model. See schema/embedding-config.ts.

CREATE TABLE IF NOT EXISTS "embedding_config" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer DEFAULT 768 NOT NULL,
	"primary_provider" text NOT NULL,
	"primary_base_url" text,
	"primary_api_key_id" uuid,
	"primary_label" text,
	"backup_enabled" boolean DEFAULT false NOT NULL,
	"backup_provider" text,
	"backup_base_url" text,
	"backup_api_key_id" uuid,
	"backup_label" text,
	"last_failover_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embedding_config" ADD CONSTRAINT "embedding_config_primary_api_key_id_api_keys_id_fk" FOREIGN KEY ("primary_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "embedding_config" ADD CONSTRAINT "embedding_config_backup_api_key_id_api_keys_id_fk" FOREIGN KEY ("backup_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Seed the singleton from the existing `embedding` ai-worker row (one per
-- owner) as the PRIMARY route. Owners with no embedding worker fall back to the
-- local default at resolve time (no row is fine — see resolveEmbeddingConfig).
INSERT INTO "embedding_config" ("owner_id", "model", "dimensions", "primary_provider", "primary_api_key_id", "primary_label")
SELECT w."owner_id",
       COALESCE(w."model", 'embeddinggemma:latest'),
       768,
       COALESCE(w."provider", 'local'),
       w."api_key_id",
       'Primary'
FROM "ai_workers" w
WHERE w."kind" = 'embedding'
ON CONFLICT ("owner_id") DO NOTHING;
--> statement-breakpoint
-- Retire the old override surfaces now that the config row owns the truth.
-- 1. The `embedding` ai-worker rows (the enum value stays, just unused).
DELETE FROM "ai_workers" WHERE "kind" = 'embedding';
--> statement-breakpoint
-- 2. Per-agent embedding_model overrides — agents now DISPLAY the embedder,
--    never set it. Drop the key so the boot consistency check stays quiet.
UPDATE "agents" SET "memory_config" = "memory_config" - 'embedding_model'
WHERE "memory_config" ? 'embedding_model';
--> statement-breakpoint
-- 3. The extractor worker's params.embedding_model override.
UPDATE "ai_workers" SET "params" = "params" - 'embedding_model'
WHERE "kind" = 'extractor' AND "params" ? 'embedding_model';
