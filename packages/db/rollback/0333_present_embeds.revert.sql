-- Rollback of 0333_present_embeds: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image works with 0333 in place (the edges to canvases
-- it keeps only add rows to "Grant these too"). This puts 0208's parsers
-- back, so a save leaves canvases out again, and takes 0333 off the ledger
-- so the next roll forward runs it again. The edges already made stay until
-- their page or note is saved.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0333_present_embeds.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then 0332's and 0331's reverts if going below Present, then pin the older
-- image straight away (docs/update-prod.md "Rollback").
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
    FOR m IN SELECT regexp_matches(body, '!\[[^\]]*\]\((media|draw):(' || uuid_re || ')\)', 'g') LOOP
      found := found || ((CASE m[1] WHEN 'media' THEN 'file' ELSE 'draw' END) || ':' || lower(m[2]));
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
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200140000;
