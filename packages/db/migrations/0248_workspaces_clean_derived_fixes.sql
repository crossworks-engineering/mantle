-- Workspaces, phase W2 audit fixes (plan page 4887b8e7, 5.3; migration 0247).
--
-- 1. Hosts of DELETED embeds. 0247 found a page or drawing that embeds
--    something through node_embeds, whose edges cascade away when the
--    embedded item is deleted, so a page whose stored text still holds a
--    deleted file's words was missed. mantle_embed_host() reads the content
--    itself: a page whose doc holds an embed node (an image or file of
--    another item, a drawing, a child page; the nodes docToText turns into
--    markers) and a drawing that places an image of a file node, whether or
--    not that item still exists.
-- 2. EVERY fact of a marked row is marked, retired ones too (0247 marked live
--    facts only, and entity_facts can list retired facts).
-- 3. Notes are not marked: a note's stored body is its own markdown (nothing
--    derived is stored), and its summary was made from its own words and
--    captions. Notes 0247 marked get their summary back from
--    node_mixed_summaries (nothing was lost) and their facts unmarked.
--
-- The mark runs again here with the new rule; it is idempotent. No trigger
-- here starts LLM work and nothing notifies the extractor: updated_at is kept
-- (mantle.keep_updated_at), and the extractor skips a marked page or drawing
-- until the hand-run re-fold has rewritten it (derived_mixed_unrefolded).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- Does node `id` (of type `t`) host an embed of another item, by its stored
-- content? Pages: an image or pageImage with a drawId or nodeId, a fileEmbed
-- with a nodeId, a childPage with a pageId (doc-to-text.ts embedMarker).
-- Drawings: a live image element whose fileId maps to a node in file_refs
-- (embed-closure.ts drawPlacedFileIds). Anything else: false.
CREATE OR REPLACE FUNCTION "public"."mantle_embed_host"(id uuid, t "public"."node_type")
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT CASE
    WHEN $2 = 'page' THEN EXISTS (
      SELECT 1 FROM "public"."pages" p
       WHERE p."node_id" = $1
         AND (jsonb_path_exists(p."doc",
               'strict $.** ? ((@.type == "image" || @.type == "pageImage")
                               && ((exists(@.attrs.drawId) && @.attrs.drawId.type() == "string" && @.attrs.drawId != "")
                                   || (exists(@.attrs.nodeId) && @.attrs.nodeId.type() == "string" && @.attrs.nodeId != "")))'::jsonpath)
          OR jsonb_path_exists(p."doc",
               'strict $.** ? (@.type == "fileEmbed"
                               && exists(@.attrs.nodeId) && @.attrs.nodeId.type() == "string" && @.attrs.nodeId != "")'::jsonpath)
          OR jsonb_path_exists(p."doc",
               'strict $.** ? (@.type == "childPage"
                               && exists(@.attrs.pageId) && @.attrs.pageId.type() == "string" && @.attrs.pageId != "")'::jsonpath)))
    WHEN $2 = 'draw' THEN EXISTS (
      SELECT 1 FROM "public"."draws" d
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(d."scene"->'elements') = 'array' THEN d."scene"->'elements' ELSE '[]'::jsonb END) e
       WHERE d."node_id" = $1
         AND jsonb_typeof(d."file_refs") = 'object'
         AND e->>'type' = 'image'
         AND coalesce(e->>'isDeleted', 'false') <> 'true'
         AND jsonb_typeof(e->'fileId') = 'string'
         AND jsonb_typeof(d."file_refs"->(e->>'fileId')) = 'string'
         AND d."file_refs"->>(e->>'fileId') <> '')
    ELSE false
  END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_embed_host"(uuid, "public"."node_type") FROM PUBLIC;
--> statement-breakpoint

-- The mark, with the rules above. Same signature and result as 0247:
-- `dry` counts only; `node_ids` limits it to these nodes (tests; NULL = every
-- row). facts_marked counts every fact of the newly marked rows, plus the
-- facts of rows marked earlier that were not marked yet.
CREATE OR REPLACE FUNCTION "public"."mantle_mark_derived_mixed"(dry boolean DEFAULT false, node_ids uuid[] DEFAULT NULL)
  RETURNS TABLE (node_type text, nodes_marked bigint, summaries_moved bigint, facts_marked bigint)
  LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.keep_updated_at', true), '');
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS mantle_mark_tmp (id uuid PRIMARY KEY, t text, has_summary boolean, is_new boolean)
    ON COMMIT DROP;
  TRUNCATE mantle_mark_tmp;
  -- New rows to mark.
  INSERT INTO mantle_mark_tmp (id, t, has_summary, is_new)
  SELECT n."id", n."type"::text, n."data" ? 'summary', true
    FROM "public"."nodes" n
    JOIN "public"."spaces" s ON s."id" = n."owner_id" AND s."kind" = 'brain'
   WHERE n."type" IN ('page', 'draw')
     AND NOT n."derived_mixed"
     AND (node_ids IS NULL OR n."id" = ANY (node_ids))
     AND coalesce(n."data"->>'summary_folded', '') <> 'true'
     AND (EXISTS (SELECT 1 FROM "public"."node_embeds" e WHERE e."from_id" = n."id")
          OR "public"."mantle_embed_host"(n."id", n."type"))
     AND (n."data" ? 'summary'
          OR EXISTS (SELECT 1 FROM "public"."facts" f WHERE f."source_node_id" = n."id"));
  -- Rows marked earlier whose facts are not all marked (0247 left retired
  -- facts unmarked).
  INSERT INTO mantle_mark_tmp (id, t, has_summary, is_new)
  SELECT n."id", n."type"::text, false, false
    FROM "public"."nodes" n
   WHERE n."derived_mixed" AND n."type" IN ('page', 'draw')
     AND (node_ids IS NULL OR n."id" = ANY (node_ids))
     AND EXISTS (SELECT 1 FROM "public"."facts" f
                  WHERE f."source_node_id" = n."id" AND NOT f."derived_mixed")
  ON CONFLICT (id) DO NOTHING;

  RETURN QUERY
  SELECT m.t,
         count(*) FILTER (WHERE m.is_new)::bigint,
         count(*) FILTER (WHERE m.has_summary)::bigint,
         coalesce(sum((SELECT count(*) FROM "public"."facts" f
                        WHERE f."source_node_id" = m.id AND NOT f."derived_mixed")), 0)::bigint
    FROM mantle_mark_tmp m
   GROUP BY m.t
   ORDER BY m.t;

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
      FROM mantle_mark_tmp m WHERE m.id = n."id" AND m.is_new;
    UPDATE "public"."facts" f
       SET "derived_mixed" = true
      FROM mantle_mark_tmp m
     WHERE f."source_node_id" = m.id AND NOT f."derived_mixed";
    PERFORM set_config('mantle.keep_updated_at', was, true);
  END IF;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_mark_derived_mixed"(boolean, uuid[]) FROM PUBLIC;
--> statement-breakpoint

-- Notes 0247 marked: the summary comes back from node_mixed_summaries (only
-- when the node has none since), the side row goes, the node and its facts
-- are unmarked. `node_ids`: these nodes only (tests; NULL = every row).
-- Returns the notes unmarked.
CREATE OR REPLACE FUNCTION "public"."mantle_unmark_mixed_notes"(node_ids uuid[] DEFAULT NULL)
  RETURNS bigint LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.keep_updated_at', true), '');
  ids uuid[];
BEGIN
  SELECT coalesce(array_agg(n."id"), '{}'::uuid[]) INTO ids
    FROM "public"."nodes" n
   WHERE n."type" = 'note' AND n."derived_mixed"
     AND (node_ids IS NULL OR n."id" = ANY (node_ids));
  IF cardinality(ids) = 0 THEN RETURN 0; END IF;
  PERFORM set_config('mantle.keep_updated_at', 'on', true);
  UPDATE "public"."nodes" n
     SET "data" = coalesce(n."data", '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'summary', s."summary", 'summary_model', s."summary_model",
           'summary_at', s."summary_at", 'entities', s."entities"))
    FROM "public"."node_mixed_summaries" s
   WHERE s."node_id" = n."id" AND n."id" = ANY (ids)
     AND NOT (coalesce(n."data", '{}'::jsonb) ? 'summary');
  DELETE FROM "public"."node_mixed_summaries" WHERE "node_id" = ANY (ids);
  UPDATE "public"."facts" SET "derived_mixed" = false
   WHERE "source_node_id" = ANY (ids) AND "derived_mixed";
  UPDATE "public"."nodes" SET "derived_mixed" = false WHERE "id" = ANY (ids);
  PERFORM set_config('mantle.keep_updated_at', was, true);
  RETURN cardinality(ids);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_unmark_mixed_notes"(uuid[]) FROM PUBLIC;
--> statement-breakpoint

SELECT "public"."mantle_unmark_mixed_notes"(NULL);
--> statement-breakpoint
SELECT * FROM "public"."mantle_mark_derived_mixed"(false, NULL);
