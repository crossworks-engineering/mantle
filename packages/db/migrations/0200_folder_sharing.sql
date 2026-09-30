-- The item tree, phase 4: sharing a folder (docs/folder-tree.md).
--
-- 1. nodes.share_level: a folder's share, team or client (public stays a
--    per-item link). Only on folders under a kind whose folders may be
--    shared (the TREE_KIND_SPECS `shareable` kinds).
-- 2. nodes.inherited_level: on any row, the share of the nearest shared
--    folder holding it (same owner), or null. An item's path IS its folder's
--    path, so an item inherits from the folder at its own path; a folder
--    inherits only from the folders strictly above it (its own share is
--    share_level, not inherited). Kept true by the
--    database, not by route code, so every writer that puts an item in a
--    folder (the UI, agents, uploads, the disk watcher, Accept, the crawler)
--    makes "what lands here later is shared too" hold:
--      - BEFORE INSERT OR UPDATE OF path: a row takes its value from its
--        new ancestors.
--      - AFTER UPDATE OF path, share_level on a folder: the whole subtree is
--        refreshed. AFTER row triggers fire once the statement is done, so a
--        subtree rewrite is seen whole and any stale BEFORE value is fixed.
--      - The refresh writes only inherited_level, which neither trigger
--        watches, so nothing re-fires. Column lists keep ordinary writes
--        (summaries, embeddings, updated_at) from firing them at all.
-- 3. The type ceiling holds for the inherited level as for `audience`: only
--    workspace kinds ever carry one (journal, tasks, secrets... never).
-- 4. The one policy change: a viewer reads a brain row at its own level OR
--    at its inherited level. Still a same-row check.
--
-- A member's draft (another owner) never inherits: the lookup matches the
-- row's own owner only. Existing data: share_level is null everywhere, so
-- inherited_level is null everywhere and nobody's access changes.
--
-- Rollback: the previous release never writes share_level, so every
-- inherited_level stays null and the widened policy reads exactly what the
-- old one did.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."nodes"
  ADD COLUMN IF NOT EXISTS "share_level" text,
  ADD COLUMN IF NOT EXISTS "inherited_level" text;
--> statement-breakpoint

-- NOT VALID: both columns are null on every existing row, and a validating
-- scan of nodes would hold its lock for nothing. New and changed rows are
-- checked.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_share_level_ck') THEN
    ALTER TABLE "public"."nodes" ADD CONSTRAINT "nodes_share_level_ck" CHECK (
      "share_level" IS NULL
      OR ("share_level" IN ('team', 'client')
          AND "type" = 'branch'
          AND nlevel("path") > 1
          AND subpath("path", 0, 1)::text IN
                ('files', 'notes', 'pages', 'draw', 'tables', 'formulas', 'apps'))
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_inherited_level_ck') THEN
    ALTER TABLE "public"."nodes" ADD CONSTRAINT "nodes_inherited_level_ck" CHECK (
      "inherited_level" IS NULL
      OR ("inherited_level" IN ('team', 'client')
          AND "public"."mantle_workspace_kind"("type"))
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

-- Shared folders are few: this is what the triggers' ancestor lookup scans.
CREATE INDEX IF NOT EXISTS "nodes_shared_folder_idx"
  ON "public"."nodes" ("owner_id") WHERE "share_level" IS NOT NULL;
--> statement-breakpoint

-- The share a row inherits: the deepest shared folder holding `p` with the
-- same owner (for a folder, strictly above it), for workspace kinds only.
CREATE OR REPLACE FUNCTION "public"."mantle_inherited_level"(o uuid, p ltree, t "public"."node_type")
  RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN NOT "public"."mantle_workspace_kind"(t) OR nlevel(p) < 2 THEN NULL ELSE (
    SELECT a."share_level" FROM "public"."nodes" a
     WHERE a."owner_id" = o AND a."share_level" IS NOT NULL
       AND a."path" @> p AND (t <> 'branch' OR a."path" <> p)
     ORDER BY nlevel(a."path") DESC
     LIMIT 1
  ) END
$$;
--> statement-breakpoint

-- Refresh every row of one owner under (and including) `under`; only rows
-- whose value changes are written.
CREATE OR REPLACE FUNCTION "public"."mantle_refresh_inherited"(o uuid, under ltree)
  RETURNS void LANGUAGE sql VOLATILE AS $$
  UPDATE "public"."nodes" n
     SET "inherited_level" = "public"."mantle_inherited_level"(n."owner_id", n."path", n."type")
   WHERE n."owner_id" = o AND n."path" <@ under
     AND n."inherited_level" IS DISTINCT FROM
         "public"."mantle_inherited_level"(n."owner_id", n."path", n."type")
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_inherit_trg"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."inherited_level" := "public"."mantle_inherited_level"(NEW."owner_id", NEW."path", NEW."type");
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_nodes_refresh_trg"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "public"."mantle_refresh_inherited"(NEW."owner_id", NEW."path");
  RETURN NULL;
END
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "nodes_inherit_before" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_inherit_before"
  BEFORE INSERT OR UPDATE OF "path" ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_nodes_inherit_trg"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "nodes_share_refresh_after" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_share_refresh_after"
  AFTER UPDATE OF "path", "share_level" ON "public"."nodes"
  FOR EACH ROW
  WHEN (NEW."type" = 'branch'
        AND (OLD."path" IS DISTINCT FROM NEW."path"
             OR OLD."share_level" IS DISTINCT FROM NEW."share_level"))
  EXECUTE FUNCTION "public"."mantle_nodes_refresh_trg"();
--> statement-breakpoint

DROP POLICY IF EXISTS "nodes_viewer_read" ON "public"."nodes";
--> statement-breakpoint
CREATE POLICY "nodes_viewer_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING ("owner_id" = (SELECT "public"."mantle_brain_id"())
         AND ("audience" = ANY ("public"."mantle_viewer_audiences"())
              OR "inherited_level" = ANY ("public"."mantle_viewer_audiences"()))
         AND "public"."mantle_workspace_kind"("type"));
