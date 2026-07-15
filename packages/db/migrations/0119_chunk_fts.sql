-- Hybrid passage retrieval: give content_chunks a keyword arm.
--
-- `search_chunks` was pure cosine vector, so an exact rare token (an error
-- code, a field name, a coined term) that embeds poorly was unfindable at the
-- passage level even when it sat verbatim in a chunk — the recall audit
-- caught a term present in 6 chunks that two vector searches declared absent.
-- The node spine has had a tsvector since 0000; passages now get the same:
-- a generated FTS column + GIN index, blended into searchChunks via weighted
-- RRF exactly like searchNodes (vector spine, FTS booster).
--
-- Chunk text is capped (~3k chars) so the generated column is cheap; the
-- backfill rewrites the table once, which at chunk-table scale is seconds.

alter table "public"."content_chunks"
  add column if not exists "search_tsv" tsvector
  generated always as (to_tsvector('english', "text")) stored;

create index if not exists "content_chunks_tsv_idx"
  on "public"."content_chunks" using gin ("search_tsv");
