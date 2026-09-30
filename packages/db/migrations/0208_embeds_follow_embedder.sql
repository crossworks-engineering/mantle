-- Embeds follow their embedder through a folder share (folder audit
-- 2026-09-30, S5; dev brain "PLAN: embeds follow their embedder";
-- docs/folder-tree.md, "Sharing a folder").
--
-- Until now a confirmed folder share or move LOWERED the own `audience` of
-- every item the shared pages, drawings and notes embed, wherever those
-- items live, and an unshare only recomputed inherited_level: the embeds
-- stayed readable for good. Now an embed is readable through a folder share
-- only while an item that embeds it is read through that share. Unshare the
-- folder, move the embedder out, delete the folder, or take the embed out,
-- and that access goes; nothing's own level changes.
--
-- 1. node_embeds (from_id, to_id): the embed edges, kept by triggers from
--    the stored data, so every writer is covered, like 0204's shares:
--      - pages.doc: image and pageImage (nodeId, drawId), fileEmbed
--        (nodeId), childPage (pageId), as referencedEmbedIds walks it;
--      - draws.file_refs: every file id in the map, as drawEmbedIds;
--      - a note's data.content: images (`![..](media:id)`, `![..](draw:id)`)
--        outside code, and a file link alone in its paragraph
--        (`[..](media:id)`), as noteEmbedIds reads the markdown. Images are
--        counted wherever the note shows them (a heading or a table cell
--        too), a little more than noteEmbedIds lists: the reader sees them.
--    Only ids of existing rows (the foreign keys); a self-embed is dropped.
-- 2. nodes.embedded_level (team, client or null): the most open
--    inherited_level among the owner's rows that reach this row through
--    embeds, transitively (a note embeds a drawing that embeds an image).
--    Only through the owner's own rows, so a member's draft never passes a
--    share on. Workspace kinds only (the type ceiling). Derived, never
--    written by code.
-- 3. Refreshed by triggers, only where something can change: an edge added
--    from a row that has a share or an embedded level; an edge removed to a
--    row that has an embedded level; a row whose inherited_level or owner
--    changed and that embeds something. Opening only raises levels forward
--    through what the change reaches; closing locks (id order) and
--    recomputes, from their embedders, only the reached rows read at the
--    level that went. A brain with no shared folder never pays more than an
--    index probe per save.
-- 4. The one policy change: nodes_viewer_read reads a brain row at its own
--    level OR its inherited share OR its embedded level. Still a same-row
--    check; derived tables follow their node as before.
--
-- The client thread (0194, 0205) is unchanged: an item read only through an
-- embed has no client thread of its own; the client talks on the item that
-- embeds it.
--
-- The edge triggers are SECURITY DEFINER with a pinned search_path: a
-- member's personal-space role writes its own pages, drawings and notes and
-- holds no grant on node_embeds. Nothing a member writes can open a brain
-- row: only the brain's own rows pass a share on.
--
-- Existing data: items lowered by earlier folder shares cannot be told
-- apart from levels set on purpose, so nothing is raised; the backfill only
-- adds the embedded level where a shared folder's items embed something.
--
-- Number and order: after 0207_folder_share_delete_refresh, stamped later.
--
-- Rollback: the previous release neither reads nor writes the new column or
-- table; its policy reads less (the embedded level is ignored), and its
-- folder writes go back to lowering embeds' own level.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."nodes" ADD COLUMN IF NOT EXISTS "embedded_level" text;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_embedded_level_ck') THEN
    ALTER TABLE "public"."nodes" ADD CONSTRAINT "nodes_embedded_level_ck" CHECK (
      "embedded_level" IS NULL
      OR ("embedded_level" IN ('team', 'client')
          AND "public"."mantle_workspace_kind"("type"))
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

-- The column is null on every row: VALIDATE scans under a lock that lets
-- reads and writes go on.
ALTER TABLE "public"."nodes" VALIDATE CONSTRAINT "nodes_embedded_level_ck";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."node_embeds" (
  "from_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "to_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  PRIMARY KEY ("from_id", "to_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "node_embeds_to_idx" ON "public"."node_embeds" ("to_id");
--> statement-breakpoint

-- What a page doc embeds (referencedEmbedIds).
CREATE OR REPLACE FUNCTION "public"."mantle_page_embed_ids"(doc jsonb)
  RETURNS uuid[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH RECURSIVE w(n) AS (
    SELECT doc WHERE jsonb_typeof(doc) = 'object'
    UNION ALL
    SELECT c FROM w,
      jsonb_array_elements(CASE WHEN jsonb_typeof(w.n->'content') = 'array'
                                THEN w.n->'content' ELSE '[]'::jsonb END) c
     WHERE jsonb_typeof(c) = 'object'
  )
  SELECT coalesce(array_agg(DISTINCT lower(v)::uuid), '{}'::uuid[])
    FROM w
   CROSS JOIN LATERAL unnest(CASE w.n->>'type'
       WHEN 'image' THEN ARRAY[w.n->'attrs'->>'nodeId', w.n->'attrs'->>'drawId']
       WHEN 'pageImage' THEN ARRAY[w.n->'attrs'->>'nodeId', w.n->'attrs'->>'drawId']
       WHEN 'fileEmbed' THEN ARRAY[w.n->'attrs'->>'nodeId']
       WHEN 'childPage' THEN ARRAY[w.n->'attrs'->>'pageId']
       ELSE ARRAY[]::text[] END) v
   WHERE v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
--> statement-breakpoint

-- What a drawing embeds: every file in its file map (drawEmbedIds).
CREATE OR REPLACE FUNCTION "public"."mantle_draw_embed_ids"(refs jsonb)
  RETURNS uuid[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT lower(e.value #>> '{}')::uuid), '{}'::uuid[])
    FROM jsonb_each(CASE WHEN jsonb_typeof(refs) = 'object' THEN refs ELSE '{}'::jsonb END) e
   WHERE jsonb_typeof(e.value) = 'string'
     AND (e.value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
--> statement-breakpoint

-- What a note's markdown embeds (noteEmbedIds): images outside code, and a
-- file link alone in its paragraph.
CREATE OR REPLACE FUNCTION "public"."mantle_note_embed_ids"(md text)
  RETURNS uuid[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  uuid_re constant text := '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  lines text[];
  n int;
  line text;
  body text;
  fence text := NULL;
  m text[];
  found uuid[] := '{}';
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
    FOR m IN SELECT regexp_matches(body, '!\[[^\]]*\]\((?:media|draw):(' || uuid_re || ')\)', 'g') LOOP
      found := found || lower(m[1])::uuid;
    END LOOP;
    m := regexp_match(body, '^\s*\[[^\]]*\]\(media:(' || uuid_re || ')\)\s*$');
    IF m IS NOT NULL
       AND (i = 1 OR lines[i - 1] ~ '^\s*$')
       AND (i = n OR lines[i + 1] ~ '^\s*$') THEN
      found := found || lower(m[1])::uuid;
    END IF;
  END LOOP;
  RETURN ARRAY(SELECT DISTINCT unnest(found));
END
$$;
--> statement-breakpoint

-- The rows reached from `start` through embeds, `start` included. The walk
-- goes on only through the owner's rows, as mantle_embedded_level walks
-- back: a member's draft passes nothing on.
CREATE OR REPLACE FUNCTION "public"."mantle_embeds_reached"(o uuid, start uuid[])
  RETURNS TABLE (id uuid) LANGUAGE sql STABLE AS $$
  -- Every step is an index lookup (LATERAL), whatever the planner thinks of
  -- the recursion's size.
  WITH RECURSIVE down(id) AS (
    SELECT unnest(start)
    UNION
    SELECT nx.to_id FROM down
     CROSS JOIN LATERAL (
       SELECT e.to_id FROM "public"."node_embeds" e
        WHERE e.from_id = down.id
          AND EXISTS (SELECT 1 FROM "public"."nodes" x WHERE x.id = down.id AND x.owner_id = o)
     ) nx
  )
  SELECT down.id FROM down
$$;
--> statement-breakpoint

-- The more open of two shares (client, then team, then none).
CREATE OR REPLACE FUNCTION "public"."mantle_share_max"(a text, b text)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN 'client' IN (a, b) THEN 'client' WHEN 'team' IN (a, b) THEN 'team' END
$$;
--> statement-breakpoint

-- A row's embedded level: the most open inherited_level among the owner's
-- rows that reach it through embeds (the walk passes only the owner's rows).
CREATE OR REPLACE FUNCTION "public"."mantle_embedded_level"(o uuid, target uuid, t "public"."node_type")
  RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN NOT "public"."mantle_workspace_kind"(t) THEN NULL ELSE (
    -- Index lookups only (LATERAL): a join here let the planner scan
    -- whole tables once per row refreshed.
    WITH RECURSIVE up(id) AS (
      SELECT p.from_id FROM "public"."node_embeds" p
       WHERE p.to_id = target
         AND EXISTS (SELECT 1 FROM "public"."nodes" x WHERE x.id = p.from_id AND x.owner_id = o)
      UNION
      SELECT p.from_id FROM up
       CROSS JOIN LATERAL (
         SELECT e.from_id FROM "public"."node_embeds" e WHERE e.to_id = up.id
       ) p
       WHERE EXISTS (SELECT 1 FROM "public"."nodes" x WHERE x.id = p.from_id AND x.owner_id = o)
    )
    SELECT CASE WHEN bool_or(l.lvl = 'client') THEN 'client'
                WHEN bool_or(l.lvl = 'team') THEN 'team' END
      FROM up
     CROSS JOIN LATERAL (SELECT m.inherited_level AS lvl FROM "public"."nodes" m WHERE m.id = up.id) l
     WHERE up.id <> target
  ) END
$$;
--> statement-breakpoint

-- Opening: `lvl` now reaches what `start` reaches. It can only open, so no
-- walk back: every reached row takes the more open of its level and `lvl`.
-- (A share on a folder of a thousand notes that all embed one image sets
-- the image once; the other 999 find it done.)
CREATE OR REPLACE FUNCTION "public"."mantle_open_embedded"(o uuid, start uuid[], lvl text)
  RETURNS void LANGUAGE sql
  SET search_path = public, pg_temp AS $$
  UPDATE "public"."nodes" n
     SET "embedded_level" = lvl
   WHERE lvl IN ('team', 'client')
     AND n.owner_id = o AND n.id IN (SELECT r.id FROM "public"."mantle_embeds_reached"(o, start) r)
     AND "public"."mantle_workspace_kind"(n.type)
     AND (n."embedded_level" IS NULL OR (n."embedded_level" = 'team' AND lvl = 'client'));
$$;
--> statement-breakpoint

-- Closing: `lvl` (null = not known) may no longer reach what `start`
-- reaches. Only a row read at exactly that level can drop (one read more
-- openly has it from elsewhere): those are locked in id order, so two
-- closings of one row wait for each other and the second reads what the
-- first committed, then recomputed from their embedders.
CREATE OR REPLACE FUNCTION "public"."mantle_close_embedded"(o uuid, start uuid[], lvl text)
  RETURNS void LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF start IS NULL OR cardinality(start) = 0 THEN
    RETURN;
  END IF;
  PERFORM 1 FROM "public"."nodes" n
   WHERE n.owner_id = o AND n.id IN (SELECT r.id FROM "public"."mantle_embeds_reached"(o, start) r)
     AND n."embedded_level" IS NOT NULL AND (lvl IS NULL OR n."embedded_level" = lvl)
   ORDER BY n.id
     FOR UPDATE;
  UPDATE "public"."nodes" n
     SET "embedded_level" = "public"."mantle_embedded_level"(o, n.id, n.type)
   WHERE n.owner_id = o AND n.id IN (SELECT r.id FROM "public"."mantle_embeds_reached"(o, start) r)
     AND n."embedded_level" IS NOT NULL AND (lvl IS NULL OR n."embedded_level" = lvl)
     AND n."embedded_level" IS DISTINCT FROM "public"."mantle_embedded_level"(o, n.id, n.type);
END
$$;
--> statement-breakpoint

-- Everything `start` reaches, recomputed in full (an owner change).
CREATE OR REPLACE FUNCTION "public"."mantle_refresh_embedded"(o uuid, start uuid[])
  RETURNS void LANGUAGE plpgsql
  SET search_path = public, pg_temp AS $$
BEGIN
  IF start IS NULL OR cardinality(start) = 0 THEN
    RETURN;
  END IF;
  PERFORM 1 FROM "public"."nodes" n
   WHERE n.owner_id = o AND n.id IN (SELECT r.id FROM "public"."mantle_embeds_reached"(o, start) r)
   ORDER BY n.id
     FOR UPDATE;
  UPDATE "public"."nodes" n
     SET "embedded_level" = "public"."mantle_embedded_level"(o, n.id, n.type)
   WHERE n.owner_id = o AND n.id IN (SELECT r.id FROM "public"."mantle_embeds_reached"(o, start) r)
     AND n."embedded_level" IS DISTINCT FROM "public"."mantle_embedded_level"(o, n.id, n.type);
END
$$;
--> statement-breakpoint

-- Make a row's edges what its data says.
CREATE OR REPLACE FUNCTION "public"."mantle_sync_embeds"(f uuid, ids uuid[])
  RETURNS void LANGUAGE sql
  SET search_path = public, pg_temp AS $$
  DELETE FROM "public"."node_embeds"
   WHERE from_id = f AND NOT (to_id = ANY (coalesce(ids, '{}'::uuid[])));
  INSERT INTO "public"."node_embeds" (from_id, to_id)
  SELECT f, t FROM unnest(coalesce(ids, '{}'::uuid[])) t
   WHERE t <> f AND EXISTS (SELECT 1 FROM "public"."nodes" x WHERE x.id = t)
  ON CONFLICT DO NOTHING;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_pages_embeds_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM "public"."mantle_sync_embeds"(NEW.node_id, "public"."mantle_page_embed_ids"(NEW.doc));
  RETURN NULL;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_draws_embeds_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM "public"."mantle_sync_embeds"(NEW.node_id, "public"."mantle_draw_embed_ids"(NEW.file_refs));
  RETURN NULL;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_notes_embeds_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM "public"."mantle_sync_embeds"(NEW.id, "public"."mantle_note_embed_ids"(NEW.data->>'content'));
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- An edge added: what it points at is reached at the embedder's level (its
-- share, or what reaches it). The embedder row is locked first, so an
-- unshare of it in flight either commits before this reads it or waits for
-- this edge.
CREATE OR REPLACE FUNCTION "public"."mantle_node_embeds_added_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  src record;
  lvl text;
BEGIN
  SELECT n.owner_id, n.inherited_level, n.embedded_level INTO src
    FROM "public"."nodes" n WHERE n.id = NEW.from_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  lvl := "public"."mantle_share_max"(src.inherited_level, src.embedded_level);
  IF lvl IS NOT NULL THEN
    PERFORM "public"."mantle_open_embedded"(src.owner_id, ARRAY[NEW.to_id], lvl);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- An edge removed: only a row read through embeds can lose anything, and
-- only at the level the embedder passed on (not known when the embedder
-- itself is being deleted: then any).
CREATE OR REPLACE FUNCTION "public"."mantle_node_embeds_removed_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  tgt record;
  src record;
  lvl text := NULL;
BEGIN
  SELECT n.owner_id, n.embedded_level INTO tgt FROM "public"."nodes" n WHERE n.id = OLD.to_id;
  IF NOT FOUND OR tgt.embedded_level IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT n.owner_id, n.inherited_level, n.embedded_level INTO src
    FROM "public"."nodes" n WHERE n.id = OLD.from_id;
  IF FOUND THEN
    IF src.owner_id IS DISTINCT FROM tgt.owner_id THEN
      RETURN NULL;
    END IF;
    lvl := "public"."mantle_share_max"(src.inherited_level, src.embedded_level);
    IF lvl IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM "public"."mantle_close_embedded"(tgt.owner_id, ARRAY[OLD.to_id], lvl);
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- A row's share or owner changed: what it embeds follows.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_embed_reach_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  targets uuid[];
  was text;
  now_ text;
BEGIN
  targets := ARRAY(SELECT e.to_id FROM "public"."node_embeds" e WHERE e.from_id = NEW.id);
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN
    PERFORM "public"."mantle_refresh_embedded"(NEW.owner_id, ARRAY[NEW.id] || targets);
    PERFORM "public"."mantle_refresh_embedded"(OLD.owner_id, targets);
    RETURN NULL;
  END IF;
  IF cardinality(targets) = 0 THEN
    RETURN NULL;
  END IF;
  -- What it passes on is its share or what reaches it, the more open.
  was := "public"."mantle_share_max"(OLD.inherited_level, NEW.embedded_level);
  now_ := "public"."mantle_share_max"(NEW.inherited_level, NEW.embedded_level);
  IF was IS NOT DISTINCT FROM now_ THEN
    RETURN NULL;
  ELSIF now_ = 'client' OR (now_ = 'team' AND was IS NULL) THEN
    PERFORM "public"."mantle_open_embedded"(NEW.owner_id, targets, now_);
  ELSE
    PERFORM "public"."mantle_close_embedded"(NEW.owner_id, targets, was);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "pages_embeds_after" ON "public"."pages";
--> statement-breakpoint
CREATE TRIGGER "pages_embeds_after"
  AFTER INSERT OR UPDATE OF "doc" ON "public"."pages"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_pages_embeds_trg"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "draws_embeds_after" ON "public"."draws";
--> statement-breakpoint
CREATE TRIGGER "draws_embeds_after"
  AFTER INSERT OR UPDATE OF "file_refs" ON "public"."draws"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_draws_embeds_trg"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "nodes_note_embeds_ins_after" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_note_embeds_ins_after"
  AFTER INSERT ON "public"."nodes"
  FOR EACH ROW WHEN (NEW."type" = 'note')
  EXECUTE FUNCTION "public"."mantle_notes_embeds_trg"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "nodes_note_embeds_upd_after" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_note_embeds_upd_after"
  AFTER UPDATE OF "data", "type" ON "public"."nodes"
  FOR EACH ROW
  WHEN (NEW."type" = 'note'
        AND (OLD."type" IS DISTINCT FROM NEW."type"
             OR OLD."data"->>'content' IS DISTINCT FROM NEW."data"->>'content'))
  EXECUTE FUNCTION "public"."mantle_notes_embeds_trg"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "node_embeds_added_after" ON "public"."node_embeds";
--> statement-breakpoint
CREATE TRIGGER "node_embeds_added_after"
  AFTER INSERT ON "public"."node_embeds"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_node_embeds_added_trg"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "node_embeds_removed_after" ON "public"."node_embeds";
--> statement-breakpoint
CREATE TRIGGER "node_embeds_removed_after"
  AFTER DELETE ON "public"."node_embeds"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_node_embeds_removed_trg"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "nodes_embed_reach_after" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_embed_reach_after"
  AFTER UPDATE OF "path", "inherited_level", "owner_id" ON "public"."nodes"
  FOR EACH ROW
  WHEN (OLD."inherited_level" IS DISTINCT FROM NEW."inherited_level"
        OR OLD."owner_id" IS DISTINCT FROM NEW."owner_id")
  EXECUTE FUNCTION "public"."mantle_nodes_embed_reach_trg"();
--> statement-breakpoint

-- Backfill the edges from what is stored (the triggers above fire for each
-- new edge; with no embedded level yet and few shared folders anywhere,
-- they mostly return at once).
INSERT INTO "public"."node_embeds" (from_id, to_id)
SELECT p.node_id, t FROM "public"."pages" p
 CROSS JOIN LATERAL unnest("public"."mantle_page_embed_ids"(p.doc)) t
 WHERE t <> p.node_id AND EXISTS (SELECT 1 FROM "public"."nodes" x WHERE x.id = t)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "public"."node_embeds" (from_id, to_id)
SELECT d.node_id, t FROM "public"."draws" d
 CROSS JOIN LATERAL unnest("public"."mantle_draw_embed_ids"(d.file_refs)) t
 WHERE t <> d.node_id AND EXISTS (SELECT 1 FROM "public"."nodes" x WHERE x.id = t)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "public"."node_embeds" (from_id, to_id)
SELECT n.id, t FROM "public"."nodes" n
 CROSS JOIN LATERAL unnest("public"."mantle_note_embed_ids"(n.data->>'content')) t
 WHERE n.type = 'note' AND n.data ? 'content'
   AND t <> n.id AND EXISTS (SELECT 1 FROM "public"."nodes" x WHERE x.id = t)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Statistics for the walks' planner before the first refresh (a fresh
-- table plans as if empty).
ANALYZE "public"."node_embeds";
--> statement-breakpoint

-- The one policy change.
DROP POLICY IF EXISTS "nodes_viewer_read" ON "public"."nodes";
--> statement-breakpoint
CREATE POLICY "nodes_viewer_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING ("owner_id" = (SELECT "public"."mantle_brain_id"())
         AND ("audience" = ANY ("public"."mantle_viewer_audiences"())
              OR "inherited_level" = ANY ("public"."mantle_viewer_audiences"())
              OR "embedded_level" = ANY ("public"."mantle_viewer_audiences"()))
         AND "public"."mantle_workspace_kind"("type"));
