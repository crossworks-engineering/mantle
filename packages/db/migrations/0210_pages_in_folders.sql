-- Folder system phase 7: pages live in folders, and a page is never the
-- parent of another page (docs/folder-tree.md, "Pages").
--
-- Before this, a sub-page was a page whose parent_id named another page and
-- whose path extended the parent's with its own id (`pages.<id>.<id>`). From
-- this release pages join the item tree like notes: a page's path is its
-- folder's path (a `branch` row under `pages`, at most three levels), and
-- parent_id means nothing for a page.
--
-- What it does, for every owner (the brain and the members' spaces alike):
--
-- 1. Every brain that has a page gets its `pages` root row (the tree reads
--    it; every create made it lazily before).
-- 2. Every page that had child pages becomes a page NEXT TO a folder of its
--    own name, and the former children move into that folder, one level of
--    the old hierarchy at a time (a parent before its children, so a child
--    that had children of its own makes its folder inside its parent's).
--    The folder's name is the page's title; its slug follows the tree's rule
--    (folderSlugOf, @mantle/files: lower-case, NFKD, dashes for anything
--    else; a title with no Latin letter or digit gets `f-` and ten hex
--    characters of its hash); a slug already taken there gets `-2`, `-3`.
--    Past the third folder level no folder is made: the children land in
--    the deepest folder allowed, next to their parent. Nothing is lost: every
--    page keeps its id, its document, its tags, its level and its links.
-- 3. Every page's parent_id that names a page is cleared: parent_id is ON
--    DELETE CASCADE, and a page must never take other pages with it.
-- 4. Any page whose path is not a folder of its owner (the old `pages.<id>`
--    shapes, a lone leftover) moves to the deepest folder above it, or the
--    root.
--
-- Idempotent: a second run finds no page with a page parent and no stray
-- path, and writes nothing. The share triggers (0204, 0207) run on every
-- path change here, so inherited levels stay right; the row rules never
-- change (no folder of pages is shared before this release).
--
-- ORDER: this `when` (1790018880000) is above 0209's.
--
-- Rollback: the previous release reads a page's place from parent_id (all
-- null now: every page shows at the top level, in the order it sorts by) and
-- never reads the new folder rows, so nothing breaks; the old nesting is not
-- restored.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- The tree's slug for a folder a person names (folderSlugOf in
-- packages/files/src/slug.ts), as an ltree label: lower-case, NFKD, runs of
-- anything but [a-z0-9] become one underscore, trimmed, at most 64
-- characters; a name with no Latin letter or digit gets f_ and the first
-- ten hex characters of the SHA-1 of its NFC text. Kept as a function so the
-- parity test (pages-in-folders.db.test.ts) can pin it to the TypeScript.
CREATE OR REPLACE FUNCTION "public"."mantle_folder_label"(name text)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN plain <> '' THEN plain
    WHEN btrim(name) = '' THEN NULL
    ELSE 'f_' || left(encode(digest(convert_to(normalize(btrim(name), NFC), 'UTF8'), 'sha1'), 'hex'), 10)
  END
  FROM (
    SELECT btrim(
             left(
               btrim(
                 regexp_replace(normalize(lower(name), NFKD), '[^a-z0-9]+', '_', 'g'),
                 '_'),
               64),
             '_') AS plain
  ) s
$$;
--> statement-breakpoint

DO $$
DECLARE
  r record;
  at_path ltree;
  folder_path ltree;
  label text;
  base text;
  title text;
  n integer;
  parents integer := 0;
  made integer := 0;
  moved integer := 0;
  strays integer := 0;
BEGIN
  -- 1. The pages root, for every brain with a page. A member's space keeps
  --    no root row: its folders are its own rows at brain folder paths.
  INSERT INTO "public"."nodes" (owner_id, type, title, slug, path, data, tags)
  SELECT DISTINCT p.owner_id, 'branch', 'Pages', 'pages', 'pages'::ltree, '{}'::jsonb, '{}'
    FROM "public"."nodes" p
   WHERE p.type = 'page'
     AND NOT EXISTS (SELECT 1 FROM "public"."spaces" s WHERE s.id = p.owner_id AND s.kind <> 'brain')
  ON CONFLICT (owner_id, path) WHERE type = 'branch' DO NOTHING;

  -- 2. The parent pages, shallowest first. A page in a loop of parents
  --    (never made by the code; cycle-safe anyway) is not reached here: step
  --    3 detaches it and step 4 places it.
  FOR r IN
    WITH RECURSIVE t AS (
      SELECT p.id, 0 AS depth, ARRAY[p.id] AS seen
        FROM "public"."nodes" p
       WHERE p.type = 'page'
         AND (p.parent_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM "public"."nodes" q
                              WHERE q.id = p.parent_id AND q.type = 'page'))
      UNION ALL
      SELECT c.id, t.depth + 1, t.seen || c.id
        FROM "public"."nodes" c
        JOIN t ON c.parent_id = t.id
       WHERE c.type = 'page' AND NOT (c.id = ANY (t.seen))
    )
    SELECT p.id, p.owner_id, p.title
      FROM t
      JOIN "public"."nodes" p ON p.id = t.id
     WHERE EXISTS (SELECT 1 FROM "public"."nodes" c
                    WHERE c.parent_id = p.id AND c.type = 'page' AND c.owner_id = p.owner_id)
     ORDER BY t.depth, p.title, p.id
  LOOP
    parents := parents + 1;
    -- Where the page sits now: its own parent's folder when that parent was
    -- handled above, else where it was (the root, for a top-level page). A
    -- path that is not a folder (the old id-label shape) counts as its
    -- deepest folder above, or the root.
    SELECT p.path INTO at_path FROM "public"."nodes" p WHERE p.id = r.id;
    IF at_path IS NULL OR NOT (at_path <@ 'pages'::ltree) THEN
      at_path := 'pages'::ltree;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "public"."nodes" b
                    WHERE b.owner_id = r.owner_id AND b.type = 'branch' AND b.path = at_path) THEN
      SELECT b.path INTO at_path FROM "public"."nodes" b
       WHERE b.owner_id = r.owner_id AND b.type = 'branch'
         AND b.path @> at_path AND b.path <@ 'pages'::ltree
       ORDER BY nlevel(b.path) DESC LIMIT 1;
      IF at_path IS NULL THEN at_path := 'pages'::ltree; END IF;
    END IF;

    IF nlevel(at_path) >= 4 THEN
      -- Three folders deep already: the children flatten in next to it.
      folder_path := at_path;
    ELSE
      title := left(btrim(regexp_replace(coalesce(r.title, ''), '\s+', ' ', 'g')), 60);
      IF title = '' THEN title := 'Untitled page'; END IF;
      base := coalesce("public"."mantle_folder_label"(title), 'untitled_page');
      label := base;
      n := 1;
      WHILE EXISTS (SELECT 1 FROM "public"."nodes" b
                     WHERE b.owner_id = r.owner_id AND b.type = 'branch'
                       AND b.path = at_path || label::ltree) LOOP
        n := n + 1;
        label := left(base, 60) || '_' || n::text;
      END LOOP;
      folder_path := at_path || label::ltree;
      INSERT INTO "public"."nodes" (owner_id, type, title, slug, path, data, tags)
      VALUES (r.owner_id, 'branch', title, replace(label, '_', '-'), folder_path, '{}'::jsonb, '{}');
      made := made + 1;
    END IF;

    -- The parent page goes next to (into) the folder; its children go in
    -- and stop being children. A child that has children of its own is a
    -- later row of this loop, and finds itself in this folder then.
    UPDATE "public"."nodes" SET path = folder_path
     WHERE id = r.id AND path IS DISTINCT FROM folder_path;
    UPDATE "public"."nodes" SET path = folder_path, parent_id = NULL
     WHERE parent_id = r.id AND type = 'page' AND owner_id = r.owner_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    moved := moved + n;
  END LOOP;

  -- 3. No page keeps a page as its parent (a loop, a parent of another owner).
  UPDATE "public"."nodes" c SET parent_id = NULL
   WHERE c.type = 'page' AND c.parent_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM "public"."nodes" q WHERE q.id = c.parent_id AND q.type = 'page');

  -- 4. Every page under `pages` sits at a folder of its owner, or the root:
  --    a path with no folder row (the old `pages.<id>` shape) becomes the
  --    deepest folder above it. A member's page keeps a brain folder's path
  --    (its owner is the space, the folder row the brain's), so a space's
  --    page is judged against the brain's folders as well as its own
  --    (mantle_brain_id: the one brain of this database).
  UPDATE "public"."nodes" p
     SET path = coalesce(
           (SELECT b.path FROM "public"."nodes" b
             WHERE b.type = 'branch' AND b.path @> p.path AND b.path <@ 'pages'::ltree
               AND b.owner_id IN (p.owner_id, "public"."mantle_brain_id"())
             ORDER BY nlevel(b.path) DESC LIMIT 1),
           'pages'::ltree)
   WHERE p.type = 'page' AND p.path <@ 'pages'::ltree AND p.path <> 'pages'::ltree
     AND NOT EXISTS (SELECT 1 FROM "public"."nodes" b
                      WHERE b.type = 'branch' AND b.path = p.path
                        AND b.owner_id IN (p.owner_id, "public"."mantle_brain_id"()));
  GET DIAGNOSTICS strays = ROW_COUNT;

  RAISE NOTICE 'folders phase 7: % parent page(s) became a page next to a folder (% folder(s) made), % child page(s) filed, % stray path(s) placed',
    parents, made, moved, strays;
END $$;
