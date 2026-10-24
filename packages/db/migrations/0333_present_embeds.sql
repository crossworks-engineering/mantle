-- A Present canvas a page or a note embeds is an embed edge, as a drawing
-- is (docs/proposals/canvas-files.md section 14): the page and note embed
-- triggers of 0208 read `presentId` (an image or page image node) and the
-- `present:` image of a note's markdown (`![Title](present:<id>)`).
--
-- What the edge does since workspaces W5b2 (0261): no reader gains anything
-- by it. It is what the Grant Access panel offers under "Grant these too"
-- (mantle_item_embeds, 0291), so an owner who grants a page to a workspace
-- can grant the canvases it shows with it, exactly as the drawings it
-- shows. A canvas never granted stays the 404 it was for that workspace.
--
-- Only the two parsers change (CREATE OR REPLACE, the same signatures);
-- every trigger of 0208 calls them as before. The backfill makes the edges
-- of the pages and notes that already embed a canvas (none before this
-- release wrote one): one scan of the pages and the notes, once, that
-- rewrites edges only where a canvas is named.
--
-- Rollback: packages/db/rollback/0333_present_embeds.revert.sql puts 0208's
-- parsers back; the older image works either way.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_page_embed_refs"(doc jsonb)
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH RECURSIVE w(n) AS (
    SELECT doc WHERE jsonb_typeof(doc) = 'object'
    UNION ALL
    SELECT c FROM w,
      jsonb_array_elements(CASE WHEN jsonb_typeof(w.n->'content') = 'array'
                                THEN w.n->'content' ELSE '[]'::jsonb END) c
     WHERE jsonb_typeof(c) = 'object'
  )
  SELECT coalesce(array_agg(DISTINCT r.kind || ':' || lower(r.v)), '{}'::text[])
    FROM w
   CROSS JOIN LATERAL (
     SELECT CASE WHEN jsonb_typeof(w.n->'attrs') = 'object' THEN w.n->'attrs' END AS a
   ) at
   CROSS JOIN LATERAL (VALUES
       ('file', CASE WHEN w.n->>'type' IN ('image', 'pageImage', 'fileEmbed')
                     THEN at.a->>'nodeId' END),
       ('draw', CASE WHEN w.n->>'type' IN ('image', 'pageImage') THEN at.a->>'drawId' END),
       ('present', CASE WHEN w.n->>'type' IN ('image', 'pageImage') THEN at.a->>'presentId' END),
       ('page', CASE WHEN w.n->>'type' = 'childPage' THEN at.a->>'pageId' END)
   ) r(kind, v)
   WHERE r.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_note_embed_refs"(md text)
  RETURNS text[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  uuid_re constant text := '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  lines text[];
  n int;
  line text;
  body text;
  fence text := NULL;
  m text[];
  found text[] := '{}';
BEGIN
  IF md IS NULL OR md = '' THEN
    RETURN found;
  END IF;
  lines := string_to_array(replace(md, E'\r\n', E'\n'), E'\n');
  n := coalesce(array_length(lines, 1), 0);
  FOR i IN 1..n LOOP
    line := lines[i];
    IF fence IS NOT NULL THEN
      -- A fence closes on a line of the same character, at least as long.
      m := regexp_match(line, '^\s{0,3}(`{3,}|~{3,})\s*$');
      IF m IS NOT NULL AND left(m[1], 1) = left(fence, 1) AND length(m[1]) >= length(fence) THEN
        fence := NULL;
      END IF;
      CONTINUE;
    END IF;
    m := regexp_match(line, '^\s{0,3}(`{3,}|~{3,})');
    IF m IS NOT NULL THEN
      fence := m[1];
      CONTINUE;
    END IF;
    body := regexp_replace(line, '`[^`]*`', '', 'g');
    FOR m IN SELECT regexp_matches(body, '!\[[^\]]*\]\((media|draw|present):(' || uuid_re || ')\)', 'g') LOOP
      found := found || ((CASE m[1] WHEN 'media' THEN 'file' WHEN 'draw' THEN 'draw' ELSE 'present' END) || ':' || lower(m[2]));
    END LOOP;
    m := regexp_match(body, '^\s*\[[^\]]*\]\(media:(' || uuid_re || ')\)\s*$');
    IF m IS NOT NULL
       AND (i = 1 OR lines[i - 1] ~ '^\s*$')
       AND (i = n OR lines[i + 1] ~ '^\s*$') THEN
      found := found || ('file:' || lower(m[1]));
    END IF;
  END LOOP;
  RETURN ARRAY(SELECT DISTINCT unnest(found));
END
$$;
--> statement-breakpoint

SELECT "public"."mantle_sync_embeds"(
         p."node_id",
         "public"."mantle_embed_targets"(p."node_id", "public"."mantle_page_embed_refs"(p."doc")))
  FROM "public"."pages" p
 WHERE p."doc"::text LIKE '%presentId%';
--> statement-breakpoint

SELECT "public"."mantle_sync_embeds"(
         n."id",
         "public"."mantle_embed_targets"(n."id", "public"."mantle_note_embed_refs"(n."data"->>'content')))
  FROM "public"."nodes" n
 WHERE n."type" = 'note' AND coalesce(n."data"->>'content', '') LIKE '%present:%';
