-- Workspaces, phase W3: speed (plan page 4887b8e7, sections 3 and 11; the
-- CEO's decision of 2026-10-10 on the chunk and window copies).
--
-- A grant change on a folder of 50,000 items took about 38 s: it rewrote the
-- read_ws and login_id copies on every chunk and window row, and those rows
-- carry the vectors and their HNSW indexes, so no update was HOT and each one
-- re-inserted into the vector index. The copies held nothing of their own:
-- the chunk and window rules for mantle_view_user were exactly the node's
-- rule. So:
--
--  - content_chunks and content_chunk_windows lose read_ws and login_id. Their
--    rule for mantle_view_user reads the node: the row is visible when its
--    node is (EXISTS on nodes, the form pages, draws, tables and apps already
--    use; the node's own rule applies inside it). A grant change writes no
--    chunk or window row, and a reader can never see a chunk its node hides.
--  - The chunk and window insert trigger keeps only the heads check (W1: a
--    writer of chunks or windows holds the node's head; warn by default).
--  - mantle_acl_refresh copies to facts only. Facts keep their copy: a fact
--    whose source is deleted keeps its last read_ws (R7), and a fact learned
--    from chat has no node.
--
-- The GIN index on nodes.read_ws (the small-scope search path, section 3) is
-- built CONCURRENTLY after the migrations by the runner (concurrent-indexes.ts),
-- never inside a migration transaction.
--
-- No trigger here starts LLM work and nothing notifies the extractor.

-- Waits at most 5 s for each lock (nodes, chunks, windows): a queued lock
-- would stall every read behind it. On a timeout the migration fails and is
-- safe to run again.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ── The rule: chunks and windows follow their node ───────────────────────────

DROP POLICY IF EXISTS "content_chunks_user_read" ON "public"."content_chunks";
--> statement-breakpoint
CREATE POLICY "content_chunks_user_read" ON "public"."content_chunks" FOR SELECT
  TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "content_chunks"."node_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "content_chunk_windows_user_read" ON "public"."content_chunk_windows";
--> statement-breakpoint
CREATE POLICY "content_chunk_windows_user_read" ON "public"."content_chunk_windows" FOR SELECT
  TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "content_chunk_windows"."node_id"));
--> statement-breakpoint

-- ── The insert trigger: the heads check only ─────────────────────────────────

-- A new chunk or window (or one re-pointed at another node) checks that the
-- node's head is held (U1, V2): the same check as before, without the copy.
CREATE OR REPLACE FUNCTION "public"."mantle_chunk_heads_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NEW."node_id" IS NULL THEN RETURN NEW; END IF;
  PERFORM "public"."mantle_heads_require"(ARRAY[NEW."node_id"], TG_TABLE_NAME || '_write', true);
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_chunk_heads_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_chunks_acl_trg" ON "public"."content_chunks";
--> statement-breakpoint
CREATE TRIGGER "content_chunks_acl_trg"
  BEFORE INSERT OR UPDATE OF "node_id" ON "public"."content_chunks"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_chunk_heads_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_chunk_windows_acl_trg" ON "public"."content_chunk_windows";
--> statement-breakpoint
CREATE TRIGGER "content_chunk_windows_acl_trg"
  BEFORE INSERT OR UPDATE OF "node_id" ON "public"."content_chunk_windows"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_chunk_heads_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_chunks_acl_guard" ON "public"."content_chunks";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_chunk_windows_acl_guard" ON "public"."content_chunk_windows";
--> statement-breakpoint

-- ── The derivation: nodes, then facts ────────────────────────────────────────

-- Recompute the derived columns of `ids` from item_grants, then copy them to
-- the facts that follow those nodes. Writes only what changed, under the
-- internal flag (the guards let only this write the derived columns). Chunks
-- and windows hold no copy (they read their node).
CREATE OR REPLACE FUNCTION "public"."mantle_acl_refresh"(ids uuid[])
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM set_config('mantle.acl_internal', 'on', true);
  UPDATE "public"."nodes" n
     SET "read_ws" = x.r, "write_ws" = x.w, "home_ws" = x.h
    FROM (
      SELECT i.id,
             coalesce(array_agg(g."workspace_id" ORDER BY g."workspace_id")
                        FILTER (WHERE g."workspace_id" IS NOT NULL AND NOT g."excluded"),
                      '{}'::uuid[]) AS r,
             coalesce(array_agg(g."workspace_id" ORDER BY g."workspace_id")
                        FILTER (WHERE g."write" AND NOT g."excluded"),
                      '{}'::uuid[]) AS w,
             (array_agg(g."workspace_id") FILTER (WHERE g."is_home"))[1] AS h
        FROM (SELECT DISTINCT unnest(ids) AS id) i
        LEFT JOIN "public"."item_grants" g ON g."node_id" = i.id
       GROUP BY i.id
    ) x
   WHERE n."id" = x.id
     AND (n."read_ws", n."write_ws", n."home_ws") IS DISTINCT FROM (x.r, x.w, x.h);

  UPDATE "public"."facts" f
     SET "read_ws" = n."read_ws", "login_id" = n."login_id"
    FROM "public"."nodes" n
   WHERE n."id" = ANY (ids) AND f."source_node_id" = n."id"
     AND (f."read_ws", f."login_id") IS DISTINCT FROM (n."read_ws", n."login_id");
  PERFORM set_config('mantle.acl_internal', was, true);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_acl_refresh"(uuid[]) FROM PUBLIC;
--> statement-breakpoint

-- ── The copies go ────────────────────────────────────────────────────────────
-- Metadata only (no table rewrite); the space is reclaimed as rows are
-- rewritten.

ALTER TABLE "public"."content_chunks" DROP COLUMN IF EXISTS "read_ws", DROP COLUMN IF EXISTS "login_id";
--> statement-breakpoint
ALTER TABLE "public"."content_chunk_windows" DROP COLUMN IF EXISTS "read_ws", DROP COLUMN IF EXISTS "login_id";
--> statement-breakpoint

-- ── Keyword search under row security ────────────────────────────────────────
-- Under a row rule Postgres uses an index for a condition only when its
-- function is LEAKPROOF (else the condition could run on a hidden row first
-- and leak it through an error). `search_tsv @@ query` runs ts_match_vq,
-- which upstream does not mark, so every keyword arm of a limited role or
-- the workspace role scanned the whole table: 516 ms against 14.5 ms with
-- the GIN index, one query on a 50k-item brain.
-- The judgement (CEO, 2026-10-10): ts_match_vq raises no error that depends
-- on the row's data; what it can raise depends on the query alone (stack
-- depth on a deeply nested tsquery), and a stored tsvector is valid by
-- construction. So it is marked LEAKPROOF here. It needs a superuser (every
-- box runs migrations as postgres); without one this is a NOTICE and nothing
-- changes. A pg_dump restore does not carry the flag: the migration runner
-- sets it again after the migrations (leakproof.ts), and /debug/integrity
-- shows a warning row while it is missing.
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) LEAKPROOF;
  ELSE
    RAISE NOTICE 'ts_match_vq left as it is: not a superuser (keyword arms scan under row security)';
  END IF;
END
$$;
