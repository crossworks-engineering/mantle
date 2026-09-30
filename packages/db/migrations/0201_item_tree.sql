-- The item tree, phase 1 (docs/folder-tree.md).
--
-- 1. item_marks: one login's pins and opens per item, for the tree's Pinned,
--    Recent and Most used views. Owner paths write it; the viewer roles get
--    no grant (access matrix).
-- 2. Folders nest at most three levels below a kind's root (`files.a.b.c`).
--    NOT VALID: every new or moved folder is checked, existing rows are left
--    alone (no brain held a deeper folder on 2026-09-30). The writers clamp
--    or refuse before they get here; this is the backstop.
--
-- Rollback: the previous release never reads item_marks, and no folder it
-- creates is deeper than the check allows.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."item_marks" (
  "actor_id" uuid NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "pinned_at" timestamptz,
  "open_count" integer NOT NULL DEFAULT 0,
  "opened_at" timestamptz,
  PRIMARY KEY ("actor_id", "node_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "item_marks_actor_opened_idx"
  ON "public"."item_marks" ("actor_id", "opened_at");
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nodes_tree_folder_depth_ck'
  ) THEN
    ALTER TABLE "public"."nodes"
      ADD CONSTRAINT "nodes_tree_folder_depth_ck" CHECK (
        "type" <> 'branch'
        OR nlevel("path") <= 4
        OR subpath("path", 0, 1)::text NOT IN (
          'files', 'notes', 'pages', 'draw', 'tables', 'formulas',
          'apps', 'tasks', 'events', 'contacts', 'secrets'
        )
      ) NOT VALID;
  END IF;
END $$;
