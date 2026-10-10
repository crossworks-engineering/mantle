-- Workspaces, phase W2: clean derived text (plan page 4887b8e7, 5.3 with R8
-- and the CEO's option A, 2026-10-10).
--
-- From W2 on, a page's doc_text, a drawing's scene_text and every chunk hold
-- the item's own words and a plain marker per embed, at every level (the
-- code side). This migration handles what is already stored:
--
-- 1. The mark. A page, note or drawing of the brain that embeds anything
--    (node_embeds) and carries a summary or live facts was summarised from
--    text that may hold its embeds' words: nodes.derived_mixed = true.
-- 2. Its summary, model, time and entity names move OUT of nodes.data into
--    node_mixed_summaries, a table no limited role may read (nothing is
--    lost). In nodes.data they would be served to every reader of the row
--    and matched by keyword search (search_tsv is generated over data), and
--    row security cannot hide part of a row. An Admin user's item detail may
--    still show it, labelled. The extractor clears the mark when it next
--    writes a summary from folded text (data.summary_folded). No LLM work is
--    started for it.
-- 3. The row's live facts get facts.derived_mixed = true. The level roles
--    never read a marked fact; the workspace role reads one only in a scope
--    that holds the Admin workspace. A later extraction that re-asserts a
--    fact from folded text clears it.
-- 4. touch_updated_at keeps updated_at when mantle.keep_updated_at is on
--    (transaction-local): the mark and the hand-run re-fold change derived
--    data only, and a fresh updated_at would make the extractor's safety
--    nets read them as edited.
--
-- The hand-run re-fold task (pnpm maintain refold-embeds) rewrites doc_text,
-- scene_text, the chunks and the node vector of these rows on the local
-- embedder. No trigger here starts LLM work, and nothing here notifies the
-- extractor.

-- Waits at most 5 s for each lock (nodes, facts), like 0245 and 0246: a queued
-- lock on nodes would stall every node read and write behind it. On a
-- timeout the migration fails and is safe to run again.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('mantle.keep_updated_at', true), '') = 'on' THEN
    NEW.updated_at = OLD.updated_at;
  ELSE
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

ALTER TABLE "public"."nodes"
  ADD COLUMN IF NOT EXISTS "derived_mixed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."facts"
  ADD COLUMN IF NOT EXISTS "derived_mixed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."node_mixed_summaries" (
  "node_id" uuid PRIMARY KEY REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "summary" text,
  "summary_model" text,
  "summary_at" text,
  "entities" jsonb,
  "moved_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The admin pool only: row security on, no policy, no grant (ACCESS_MATRIX).
ALTER TABLE "public"."node_mixed_summaries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Does the current workspace scope hold the Admin workspace? Runs as the
-- caller: the workspace role reads the workspaces of its own scope (0242).
CREATE OR REPLACE FUNCTION "public"."mantle_scope_has_admin"()
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."workspaces" w
     WHERE w."is_admin" AND w."archived_at" IS NULL
       AND w."id" = ANY ("public"."mantle_scope_ws"()))
$$;
--> statement-breakpoint

-- The mark (1 to 3 above). `dry`: count only. `node_ids`: these nodes only
-- (tests; NULL = every row). Idempotent: a row whose summary was written
-- from folded text (data.summary_folded) or that is marked already is left
-- alone. Owner only.
CREATE OR REPLACE FUNCTION "public"."mantle_mark_derived_mixed"(dry boolean DEFAULT false, node_ids uuid[] DEFAULT NULL)
  RETURNS TABLE (node_type text, nodes_marked bigint, summaries_moved bigint, facts_marked bigint)
  LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.keep_updated_at', true), '');
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS mantle_mark_tmp (id uuid PRIMARY KEY, t text, has_summary boolean)
    ON COMMIT DROP;
  TRUNCATE mantle_mark_tmp;
  INSERT INTO mantle_mark_tmp (id, t, has_summary)
  SELECT n."id", n."type"::text, n."data" ? 'summary'
    FROM "public"."nodes" n
    JOIN "public"."spaces" s ON s."id" = n."owner_id" AND s."kind" = 'brain'
   WHERE n."type" IN ('page', 'note', 'draw')
     AND NOT n."derived_mixed"
     AND (node_ids IS NULL OR n."id" = ANY (node_ids))
     AND coalesce(n."data"->>'summary_folded', '') <> 'true'
     AND EXISTS (SELECT 1 FROM "public"."node_embeds" e WHERE e."from_id" = n."id")
     AND (n."data" ? 'summary'
          OR EXISTS (SELECT 1 FROM "public"."facts" f
                      WHERE f."source_node_id" = n."id" AND f."valid_to" IS NULL));

  IF NOT dry THEN
    PERFORM set_config('mantle.keep_updated_at', 'on', true);
    INSERT INTO "public"."node_mixed_summaries" ("node_id", "summary", "summary_model", "summary_at", "entities")
    SELECT n."id", n."data"->>'summary', n."data"->>'summary_model', n."data"->>'summary_at',
           n."data"->'entities'
      FROM "public"."nodes" n JOIN mantle_mark_tmp m ON m.id = n."id"
     WHERE m.has_summary
    ON CONFLICT ("node_id") DO NOTHING;
    UPDATE "public"."nodes" n
       SET "derived_mixed" = true,
           "data" = n."data" - 'summary' - 'summary_model' - 'summary_at' - 'entities'
      FROM mantle_mark_tmp m WHERE m.id = n."id";
    UPDATE "public"."facts" f
       SET "derived_mixed" = true
      FROM mantle_mark_tmp m
     WHERE f."source_node_id" = m.id AND f."valid_to" IS NULL AND NOT f."derived_mixed";
    PERFORM set_config('mantle.keep_updated_at', was, true);
  END IF;

  RETURN QUERY
  SELECT m.t,
         count(*)::bigint,
         count(*) FILTER (WHERE m.has_summary)::bigint,
         coalesce(sum((SELECT count(*) FROM "public"."facts" f
                        WHERE f."source_node_id" = m.id AND f."valid_to" IS NULL)), 0)::bigint
    FROM mantle_mark_tmp m
   GROUP BY m.t
   ORDER BY m.t;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_mark_derived_mixed"(boolean, uuid[]) FROM PUBLIC;
--> statement-breakpoint

SELECT * FROM "public"."mantle_mark_derived_mixed"(false, NULL);
--> statement-breakpoint

-- The read rule for facts (3 above).
DROP POLICY IF EXISTS "facts_viewer_read" ON "public"."facts";
--> statement-breakpoint
CREATE POLICY "facts_viewer_read" ON "public"."facts" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING ("source_node_id" IS NOT NULL
         AND NOT "derived_mixed"
         AND EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "facts"."source_node_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "facts_user_read" ON "public"."facts";
--> statement-breakpoint
CREATE POLICY "facts_user_read" ON "public"."facts" FOR SELECT
  TO mantle_view_user
  USING ("read_ws" && (SELECT "public"."mantle_scope_ws"())
         AND ("login_id" IS NULL OR "login_id" = (SELECT "public"."mantle_login_id"()))
         AND (NOT "derived_mixed" OR (SELECT "public"."mantle_scope_has_admin"())));
