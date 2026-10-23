-- The Present workspace (docs/proposals/canvas-files.md section 4.1). One
-- `presents` row per present node: `source` is the canvas, a whole HTML
-- document and the source of truth; `source_text` the derived text search
-- and the extractor read; `meta` what the save step read off the head
-- (size, theme, the libraries it imports); `css` the Tailwind utilities
-- compiled from the source on save; `poster_png` a cached picture (never the
-- source) and `poster_rev` the rev it shows. Item metadata (title, tags,
-- summary) stays on the parent `nodes` row, the same split as `draws`.
--
-- No draft and no commit: a save is live at once. `rev` is the optimistic
-- concurrency etag only. `index_due_at` is the quiet-period rule (section
-- 4.3): a save whose text changed sets it ahead, later saves push it on, and
-- the item is re-indexed once, after the quiet period, never once per save.
--
-- `present_revisions` keeps the last versions of `source` (decision 4: ten)
-- so a bad rewrite can be undone.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "presents" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"source_text" text DEFAULT '' NOT NULL,
	"meta" jsonb NOT NULL,
	"css" text DEFAULT '' NOT NULL,
	"poster_png" bytea,
	"poster_rev" integer,
	"rev" integer DEFAULT 1 NOT NULL,
	"index_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The quiet-period flush scans only the rows that wait for one.
CREATE INDEX IF NOT EXISTS "presents_index_due_idx" ON "presents" ("index_due_at")
  WHERE "index_due_at" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "present_revisions" (
	"node_id" uuid NOT NULL,
	"rev" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "present_revisions_node_id_rev_pk" PRIMARY KEY("node_id","rev")
);
--> statement-breakpoint

-- Every table the rest of this migration alters, locked in one statement
-- before the first ALTER (migrations-journal.test.ts): the two new tables
-- and `nodes`, whose folder depth check is replaced below.
LOCK TABLE "public"."presents", "public"."present_revisions", "public"."nodes" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'presents_node_id_nodes_id_fk') THEN
    ALTER TABLE "presents" ADD CONSTRAINT "presents_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'present_revisions_node_id_nodes_id_fk') THEN
    ALTER TABLE "present_revisions" ADD CONSTRAINT "present_revisions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint

-- Row security: the one login role reads a canvas through its node, as
-- `draws_user_read` (0242). Grants come from ACCESS_MATRIX (`user` column).
ALTER TABLE "public"."presents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "presents_user_read" ON "public"."presents";
--> statement-breakpoint
CREATE POLICY "presents_user_read" ON "public"."presents" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "presents"."node_id"));
--> statement-breakpoint
ALTER TABLE "public"."present_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "present_revisions_user_read" ON "public"."present_revisions";
--> statement-breakpoint
CREATE POLICY "present_revisions_user_read" ON "public"."present_revisions" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "present_revisions"."node_id"));
--> statement-breakpoint

-- The actor check on the new content tables (0275), as on `draws`.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['presents', 'present_revisions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS mantle_actor_check ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER mantle_actor_check BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.mantle_actor_check_stmt()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 'present' is a workspace kind: granted to any workspace, as 'draw'. The
-- one list of kind classes (0241) gains it; the registry
-- (@mantle/client-types/kinds) says the same (kind-registry.db.test.ts).
CREATE OR REPLACE FUNCTION "public"."mantle_kind_class"(t "public"."node_type")
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN t IN ('branch', 'file', 'note', 'page', 'table', 'app', 'formula', 'draw',
               'task', 'event', 'recall', 'present') THEN 'workspace'
    WHEN t = 'telegram_message' THEN 'conversation'
    ELSE 'admin_only'
  END
$$;
--> statement-breakpoint

-- The `present` root joins the folder depth check (last replaced in 0204).
-- NOT VALID as before: only new and changed rows are checked.
ALTER TABLE "public"."nodes" DROP CONSTRAINT IF EXISTS "nodes_tree_folder_depth_ck";
--> statement-breakpoint
ALTER TABLE "public"."nodes"
  ADD CONSTRAINT "nodes_tree_folder_depth_ck" CHECK (
    "type" <> 'branch'
    OR nlevel("path") <= 4
    OR subpath("path", 0, 1)::text NOT IN (
      'files', 'notes', 'pages', 'draw', 'tables', 'formulas',
      'apps', 'tasks', 'events', 'contacts', 'secrets', 'recall', 'present'
    )
  ) NOT VALID;
