-- Move the brain to a 768-dim embedding model (EmbeddingGemma-300m, served
-- locally via the `local` provider). EVERY vector column + index goes 1536→768.
--
-- Embeddings are DERIVED data — nulled here, then repopulated by `pnpm re-embed`
-- against the new model. That's why clearing them is safe: the source text is
-- untouched and the vectors are regenerable. Per column, the order is forced by
-- pgvector: an ALTER can't change a populated vector's dimension, so we drop the
-- index → null the values → alter the type → recreate the index.
--
-- Six columns carry vectors:
--   nodes / facts / entities / content_chunks  — re-embedded by the walk
--   tool_result_chunks                          — transient spill store; nulled
--       (not re-embedded — it self-heals as results re-spill), but the COLUMN
--       must be 768 so new spills fit
--   embedding_cache                             — TRUNCATEd; cache keys include
--       the model, so old 1536 rows are dead weight under the new model anyway

DROP INDEX IF EXISTS "nodes_embedding_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "facts_embedding_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "entities_embedding_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "content_chunks_embedding_idx";
--> statement-breakpoint
UPDATE "nodes" SET embedding = NULL WHERE embedding IS NOT NULL;
--> statement-breakpoint
UPDATE "facts" SET embedding = NULL WHERE embedding IS NOT NULL;
--> statement-breakpoint
UPDATE "entities" SET embedding = NULL WHERE embedding IS NOT NULL;
--> statement-breakpoint
UPDATE "content_chunks" SET embedding = NULL WHERE embedding IS NOT NULL;
--> statement-breakpoint
UPDATE "tool_result_chunks" SET embedding = NULL WHERE embedding IS NOT NULL;
--> statement-breakpoint
TRUNCATE "embedding_cache";
--> statement-breakpoint
ALTER TABLE "nodes" ALTER COLUMN "embedding" TYPE vector(768);
--> statement-breakpoint
ALTER TABLE "facts" ALTER COLUMN "embedding" TYPE vector(768);
--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "embedding" TYPE vector(768);
--> statement-breakpoint
ALTER TABLE "content_chunks" ALTER COLUMN "embedding" TYPE vector(768);
--> statement-breakpoint
ALTER TABLE "tool_result_chunks" ALTER COLUMN "embedding" TYPE vector(768);
--> statement-breakpoint
ALTER TABLE "embedding_cache" ALTER COLUMN "embedding" TYPE vector(768);
--> statement-breakpoint
-- All four recreated as HNSW (partial, WHERE embedding IS NOT NULL). HNSW needs
-- no training data, so building it now on the freshly-nulled columns is fine —
-- it fills incrementally as `pnpm re-embed` inserts vectors. (ivfflat would
-- train its clusters on the empty column and give permanently low recall — the
-- "created with little data" trap.) nodes was already HNSW (0057); this brings
-- facts/entities/content_chunks in line and retires the ivfflat indexes.
CREATE INDEX IF NOT EXISTS "nodes_embedding_idx" ON "nodes" USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "facts_embedding_idx" ON "facts" USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_embedding_idx" ON "entities" USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunks_embedding_idx" ON "content_chunks" USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
