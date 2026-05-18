-- Hash-keyed cache for embedding model output. Embeddings are deterministic
-- for a given (model, text) pair, so caching by content hash means
-- re-embedding identical strings (recurring email subjects, the same fact
-- restated, repeated tool descriptions, …) is free after the first call.
--
-- Keyed by sha256(model || ':' || text). Hex-encoded, 64 chars. Small table
-- with a single index. Eviction strategy: none for now — embeddings are
-- ~6 KB each, and millions of rows still fits comfortably on the VPS.

create table if not exists "public"."embedding_cache" (
  "content_hash" text primary key,
  "embedding"    vector(1536) not null,
  "created_at"   timestamptz not null default now()
);
