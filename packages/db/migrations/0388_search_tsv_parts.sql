-- nodes.search_tsv from chosen parts, each one capped (task 05eead0e).
--
-- The bug: search_tsv was generated over the WHOLE data blob (0000_init:
-- title at A, data::text at B). A tsvector holds at most 1 MB (1048575
-- bytes of lexemes and positions), so a file with more than about 1 MB of
-- text could not be saved at all: the extract's update of `data` failed
-- with 54000 "string is too long for tsvector", and text, summary and
-- status were lost on every try.
--
-- Now it is built from parts, in this order (a part's words take the
-- weight given; ts_rank's default weights are A 1.0, B 0.4, C 0.2, D 0.1):
--
--   A  the title, its first 5,000 characters;
--   B  data->>'summary', its first 15,000 characters;
--   C  every other small field: data minus the summary and the long keys
--      below, as JSON text (as before), its first 20,000 characters (jsonb
--      orders keys shortest first, so a big field under a short name can
--      push longer-named ones past the cap; they stay in the row);
--   D  the long text: data->>'agent_text', 'text', 'content', 'body' and
--      'markdown' in that order, joined, the first 90,000 characters.
--      agent_text comes first: it is short (a drawing's fields, tags and
--      title block) and would be cut off behind a long text; its JSON
--      escapes for line ends ("\n") become spaces, so the word after one
--      is found.
--
-- The long keys are where an item's body lives: `text` (a file's text,
-- up to 1M characters since large PDFs), `content` (notes, documentation,
-- text files), `body` (tasks, events, journal, locations), `markdown`, and
-- `agent_text` (the Agents' tab texts on a file, 0377). `ocr` is a small
-- status object ({ pages_read, pages_total }), so it stays in C.
--
-- Nothing is lost: a small item keeps all its words here; a big file is
-- searched in full through its passages (content_chunks, their own
-- tsvector and vectors), which the extractor writes from the full text.
-- Only words past 90,000 characters of a long text are no longer found
-- through nodes.search_tsv itself.
--
-- Why these caps, not 200,000: measured on pg18, the worst input makes
-- about 7.5 bytes of tsvector per character (hyphenated pairs of distinct
-- 4-byte letters: "X-Y" gives three lexemes, each with a position). The
-- caps add up to 130,000 characters, so the worst case is about 975,000
-- bytes, under the limit with room (search-tsv-parts.db.test.ts fills
-- every cap with that input). Plain text makes 1 to 3 bytes a character.
--
-- `data` that is not an object (a JSON string a client stored as a whole,
-- an array) goes to C whole, as JSON text, as before: `jsonb - text[]`
-- raises "cannot delete from scalar" on a scalar, which would fail the
-- rewrite and every later write of such a row. Its ->> parts are NULL.
--
-- Every function in the expression is IMMUTABLE (to_tsvector with a
-- regconfig, setweight, left, coalesce, replace, ->>, jsonb_typeof, CASE,
-- jsonb - text[], jsonb::text, ||), as a generated column needs. The 0249 note on ts_match_vq stays
-- true: the column is still a tsvector built by to_tsvector, valid by
-- construction, and the LEAKPROOF flag is on the function, not the column.
--
-- SET EXPRESSION (pg17 and later; every box runs 17 or 18, and an older
-- server stops here with a clear error) keeps the column in its place,
-- rewrites the table under an ACCESS EXCLUSIVE lock (reads wait too) and
-- rebuilds every index of nodes, the HNSW one on embedding among them,
-- at the box's own settings. It runs once at the roll. Measured on pg18
-- (16 threads) on a generated brain of 200,000 nodes, all with a vector,
-- 60,000 of them files of 42 KB of text and 50 of 2 MB (9.1 GB table,
-- 781 MB HNSW, 658 MB GIN): 1,066 s, about 18 minutes, during which nodes
-- can be neither read nor written; 580 s of it is the text, the rest the
-- vector index. The time grows with the text on the nodes (about 4.5 MB a
-- second) and the vectors. maintenance_work_mem is not raised: at 1 GB
-- the parallel HNSW build asks for a shared memory segment of that size,
-- which Docker's default 64 MB /dev/shm refuses ("could not resize shared
-- memory segment"), and a serial build at 1 GB saved only 12%. The
-- column's statistics are taken again at the end (mantle_lexeme_df reads
-- them).
-- No row trigger fires on a rewrite: nothing starts LLM work, nothing
-- re-reads a stored file, updated_at stays.
--
-- Rollback: packages/db/rollback/0388_search_tsv_parts.revert.sql puts the
-- 0000 expression back (the older image reads the column the same way).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION '0388 needs Postgres 17 or later (ALTER COLUMN ... SET EXPRESSION); this server is %',
      current_setting('server_version');
  END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE "public"."nodes" ALTER COLUMN "search_tsv" SET EXPRESSION AS (
  setweight(to_tsvector('english', left(coalesce("title", ''), 5000)), 'A') ||
  setweight(to_tsvector('english', left(coalesce("data" ->> 'summary', ''), 15000)), 'B') ||
  setweight(to_tsvector('english', left(
    (CASE WHEN jsonb_typeof("data") = 'object'
          THEN "data" - ARRAY['summary', 'text', 'content', 'body', 'markdown', 'agent_text']::text[]
          ELSE "data" END)::text,
    20000)), 'C') ||
  setweight(to_tsvector('english', left(
    coalesce(replace("data" ->> 'agent_text', E'\\n', ' '), '') || ' ' ||
    coalesce("data" ->> 'text', '') || ' ' ||
    coalesce("data" ->> 'content', '') || ' ' ||
    coalesce("data" ->> 'body', '') || ' ' ||
    coalesce("data" ->> 'markdown', ''),
    90000)), 'D')
);
--> statement-breakpoint
ANALYZE "public"."nodes" ("search_tsv");
