-- Vector index on the primary brain table.
--
-- 0000_init.sql declared `nodes.embedding vector(1536)` and left a note:
-- "Vector index added after first batch of rows; ivfflat needs data to train."
-- That follow-up never landed, so every semantic retrieval — the responder's
-- content-index hits (apps/agent/src/main.ts) and the /assistant content path —
-- ran `ORDER BY embedding <=> queryVec LIMIT n` as a full sequential scan of
-- the entire nodes table on every message. On a system designed to grow to
-- tens of thousands of nodes, that's the latency cliff.
--
-- We use HNSW rather than ivfflat: it needs no training data (so it can be
-- created now on an empty/small table, sidestepping the "after first batch"
-- deferral that stranded this for good), and gives better recall at query time.
-- pgvector on the pinned pgvector/pgvector:pg17 image supports it.
--
-- Partial (WHERE embedding IS NOT NULL) to match the query's own filter and
-- keep the index lean — telegram_message rows carry no embedding today, and
-- nodes awaiting extraction have a null embedding until the extractor fills it.
-- vector_cosine_ops matches the `<=>` cosine operator used by every read path.
CREATE INDEX IF NOT EXISTS "nodes_embedding_idx"
  ON "nodes" USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
