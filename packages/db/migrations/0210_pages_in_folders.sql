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
-- 2. Every page that had child pages stays where it is and gets a folder of
--    its own name NEXT TO it; the former children move into that folder, one
--    level of the old hierarchy at a time (a parent before its children, so a
--    child that had children of its own, now inside its parent's folder,
--    makes its folder there). The parent page never goes inside its folder:
--    that would be the index page shape Jason ruled out.
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
-- change (no folder of pages is shared before this release). The old
-- "share sub-pages" flag on a page's link (settings.cascade) is cleared:
-- nothing reads it any more.
--
-- Lock order (0207): the share lock of every owner touched is taken first,
-- shared, before any row lock, so a folder share or move on a web still
-- serving the previous release waits for this or is waited for, and neither
-- deadlocks against the trigger's own lock request.
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
-- packages/files/src/slug.ts), as an ltree label, step for step: lower-case,
-- NFKD, runs of anything but [a-z0-9] become one underscore, the ends
-- trimmed, then cut to 64 characters (a cut may end in an underscore, as
-- the TypeScript's may end in a dash); a name with no Latin letter or digit
-- gets f_ and the first ten hex characters of the SHA-1 of its NFC text.
-- lower() follows the database's collation: on the UTF-8 locales the fleet
-- runs it lowers non-ASCII letters as JavaScript does. Kept as a function so
-- the parity test (pages-in-folders.db.test.ts) can pin it to the TypeScript.
CREATE OR REPLACE FUNCTION "public"."mantle_folder_label"(name text)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN plain <> '' THEN plain
    WHEN btrim(name) = '' THEN NULL
    ELSE 'f_' || left(encode(digest(convert_to(normalize(btrim(name), NFC), 'UTF8'), 'sha1'), 'hex'), 10)
  END
  FROM (
    SELECT left(
             btrim(
               regexp_replace(normalize(lower(name), NFKD), '[^a-z0-9]+', '_', 'g'),
               '_'),
             64) AS plain
  ) s
$$;
--> statement-breakpoint

-- The folder a page sits in, for the page detail every reader gets
-- (PageDetail.folderId): the branch row at the page's path, the owner's or
-- the brain's (a member's draft sits at a brain folder's path). SECURITY
-- DEFINER like mantle_brain_id (0187): a folder's own row is not readable
-- by a member under the row rules (it inherits only from above itself), and
-- the id alone gives nothing away; the tree routes answer 404 for a folder
-- the reader may not see. Null at the top level.
CREATE OR REPLACE FUNCTION "public"."mantle_page_folder_id"(o uuid, p ltree)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT b.id FROM public.nodes b
   WHERE b.type = 'branch' AND b.path = p AND nlevel(p) > 1 AND p <@ 'pages'::ltree
     AND b.owner_id IN (o, public.mantle_brain_id())
   ORDER BY (b.owner_id = o) DESC
   LIMIT 1
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
  -- 0. The share lock of every owner with a page, shared, before any row
  --    lock (0207's order: advisory lock first, then rows).
  FOR r IN SELECT DISTINCT p.owner_id FROM "public"."nodes" p WHERE p.type = 'page' LOOP
    PERFORM pg_advisory_xact_lock_shared("public"."mantle_share_lock_key"(r.owner_id));
  END LOOP;

  -- 0b. Links a "share sub-pages" parent opened for its former children
  --     (settings.cascade on the parent's link; the cascade goes with the
  --     nesting): their live links are revoked, as turning the switch off
  --     did, and a page left at public by such a link goes back to admin.
  --     Before parent_id is cleared, while the old tree can still be walked.
  WITH RECURSIVE kids AS (
    SELECT c.id
      FROM "public"."nodes" c
      JOIN "public"."nodes" p ON p.id = c.parent_id AND p.type = 'page'
      JOIN "public"."shares" s ON s.node_id = p.id AND s.revoked_at IS NULL
                               AND s.settings->>'cascade' = 'true'
     WHERE c.type = 'page'
    UNION
    SELECT c.id FROM "public"."nodes" c JOIN kids k ON c.parent_id = k.id WHERE c.type = 'page'
  ),
  revoked AS (
    UPDATE "public"."shares" s
       SET revoked_at = now(), settings = s.settings || '{"retired": "cascade"}'::jsonb
     WHERE s.revoked_at IS NULL AND s.node_id IN (SELECT id FROM kids)
    RETURNING s.node_id
  )
  UPDATE "public"."nodes" n SET audience = 'admin'
   WHERE n.id IN (SELECT node_id FROM revoked) AND n.audience = 'public';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE 'folders phase 7: % page(s) shared only through a parent''s "share sub-pages" link went back to admin (their links revoked)', n;
  END IF;

  -- 1. The pages root, for every brain with a page (the row pages/tree.ts
  --    makes lazily). A member's space keeps no root row: its folders are
  --    its own rows at brain folder paths.
  INSERT INTO "public"."nodes" (owner_id, type, title, slug, path, data, tags)
  SELECT DISTINCT p.owner_id, 'branch'::"public"."node_type", 'Pages'::text, 'pages'::text,
         'pages'::ltree,
         '{"description": "Rich documents (TipTap). Indexed and embedded automatically."}'::jsonb,
         '{}'::text[]
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
    -- deepest folder above, or the root. The page itself stays there.
    SELECT p.path INTO at_path FROM "public"."nodes" p WHERE p.id = r.id;
    IF NOT (at_path <@ 'pages'::ltree) THEN
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
      -- Three folders deep already: no folder; the children land next to it.
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
      VALUES (r.owner_id, 'branch'::"public"."node_type", title, replace(label, '_', '-'),
              folder_path, '{}'::jsonb, '{}'::text[]);
      made := made + 1;
    END IF;

    -- The parent page stays where it is; its children go into the folder
    -- and stop being children. A child that has children of its own is a
    -- later row of this loop, and finds itself in this folder then. The
    -- page's own path is not rewritten: it is at at_path already (a stray
    -- old-shape path is placed by step 4).
    UPDATE "public"."nodes" SET path = folder_path, parent_id = NULL
     WHERE parent_id = r.id AND type = 'page' AND owner_id = r.owner_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    moved := moved + n;
  END LOOP;

  -- 3. No page keeps a page as its parent (a loop, a parent of another owner).
  UPDATE "public"."nodes" c SET parent_id = NULL
   WHERE c.type = 'page' AND c.parent_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM "public"."nodes" q WHERE q.id = c.parent_id AND q.type = 'page');
  -- The old "share sub-pages" flag on a page's link: nothing reads it now.
  UPDATE "public"."shares" SET settings = settings - 'cascade' WHERE settings ? 'cascade';

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
