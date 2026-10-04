-- Passage windows (2026-10-04, docs/recall-eval.md "Passage windows").
--
-- Extra vectors inside a retrieval chunk: each chunk is cut into ~800-char
-- sentence windows, each window gets its own vector, and passage search
-- matches a window to return its chunk. Measured on a 122k-chunk library
-- corpus: paraphrased questions found their passage in the top 50 for 29 of
-- 40 cases against 17 of 40 with chunk vectors alone.
--
-- Optional per brain, OFF by default (embedding_config.chunk_windows). The
-- table starts empty: rows come from the extractor once the switch is on, and
-- for old chunks only from the manual `chunk-windows` maintenance task (dry
-- run first; it prints the count and the cost). No trigger, no job.
--
-- No text column: the chunk holds the text. halfvec halves the index; the
-- measured set ranked identically at half precision.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."embedding_config"
  ADD COLUMN IF NOT EXISTS "chunk_windows" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."content_chunk_windows" (
  "chunk_id" uuid NOT NULL REFERENCES "public"."content_chunks"("id") ON DELETE CASCADE,
  "j" integer NOT NULL,
  "owner_id" uuid NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "embedding" halfvec(768) NOT NULL,
  PRIMARY KEY ("chunk_id", "j")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunk_windows_owner_idx"
  ON "public"."content_chunk_windows" ("owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunk_windows_node_idx"
  ON "public"."content_chunk_windows" ("node_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_chunk_windows_embedding_idx"
  ON "public"."content_chunk_windows" USING hnsw ("embedding" halfvec_cosine_ops);
--> statement-breakpoint
-- Follows its node, like content_chunks (0159): one rule, the nodes policy.
ALTER TABLE "public"."content_chunk_windows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'content_chunk_windows' AND policyname = 'content_chunk_windows_viewer_read'
  ) THEN
    CREATE POLICY "content_chunk_windows_viewer_read" ON "public"."content_chunk_windows" FOR SELECT
      TO mantle_view_team, mantle_view_client, mantle_view_public
      USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "content_chunk_windows"."node_id"));
  END IF;
END $$;
