-- Member logins, audit F07 (Jason, 2026-09-28): "Take over" and the accepted
-- snapshot.
--
-- Take over. An admin can take a SUBMITTED member item (and the bundle it
-- was submitted with) out of the Review queue into their OWN private space
-- to work on it: same node ids, re-owned, bytes moved, nothing indexed. The
-- item's space_items row stays (author_login_id is still the member) in a
-- new state, 'taken', with who took it and when. `taken_root` groups what
-- was taken together: the root itself holds NULL (it is its own root), the
-- items of its bundle name the root. From the admin's space the admin
-- accepts it (the row goes to 'accepted' and keeps the author) or gives it
-- back (the rows go back to the member's space, the root 'returned' with a
-- note). A taken item is not frozen: the admin edits it. A member never
-- reaches it: the space role sets only draft, submitted and returned (0165),
-- and a taken item sits in another space, which the member's rules never
-- show.
--
-- If the admin who took it is deactivated or deleted, the Review queue
-- offers the taken item again (the app's `reviewable` rule reads taken_by):
-- nothing moves until another admin acts. taken_by goes NULL with a hard
-- delete of that login.
--
-- The accepted snapshot. At every Accept of a member-authored item (a
-- reviewed Accept, an Accept after Take over, a left-behind Accept) the
-- accepted SAVED version is recorded here for its author. What the author
-- reads of their accepted items (/api/member/accepted) comes from here,
-- never from the brain's current version: an admin's later edits are the
-- brain's, not the member's to read. A table's workbook is copied by the
-- app (VACUUM INTO, under TABLE_DB_DIR/accepted-snapshots/); a file keeps
-- only its sha256, and its bytes are served only while the brain file still
-- has them.
--
-- Items accepted before this migration get their snapshot here, from the
-- brain's current saved version (an admin edit made before the roll is in
-- it; there is no older copy to take). A file-backed table, and a file with
-- no recorded sha256, cannot be copied in SQL: their rows are `pending`, and
-- the app completes them on the author's first read (docs/member-logins.md).
--
-- Admin pool only: no limited role holds a grant (access-matrix.ts).
--
-- Rollback: the previous code runs on this schema, except that it does not
-- know 'taken'. Give back or accept every taken item before rolling back
-- (`select node_id from space_items where review_state = 'taken'`).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- ── Take over: the state and who holds it ──────────────────────────────────
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = 'public.space_items'::regclass AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%review_state%'
  LOOP
    EXECUTE format('ALTER TABLE "public"."space_items" DROP CONSTRAINT %I', c);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "public"."space_items" ADD CONSTRAINT "space_items_review_state_check"
  CHECK ("review_state" IN ('draft', 'submitted', 'returned', 'accepted', 'taken'));
--> statement-breakpoint
ALTER TABLE "public"."space_items"
  ADD COLUMN IF NOT EXISTS "taken_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."space_items" ADD COLUMN IF NOT EXISTS "taken_at" timestamptz;
--> statement-breakpoint
-- The root this item was taken with; NULL for the root itself (and once the
-- root is gone or accepted, each leftover is its own root).
ALTER TABLE "public"."space_items" ADD COLUMN IF NOT EXISTS "taken_root" uuid
  REFERENCES "public"."space_items"("node_id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_items_taken_idx"
  ON "public"."space_items" ("taken_by") WHERE "review_state" = 'taken';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_items_taken_root_idx"
  ON "public"."space_items" ("taken_root") WHERE "taken_root" IS NOT NULL;
--> statement-breakpoint

-- ── The accepted snapshot ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."accepted_snapshots" (
  "node_id"      uuid PRIMARY KEY REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "kind"         text NOT NULL,
  "title"        text NOT NULL,
  "icon"         text,
  -- The saved version number at accept (page, drawing, table).
  "version"      integer,
  -- page: the committed document.
  "doc"          jsonb,
  -- note: its text.
  "content"      text,
  -- drawing: the committed scene, its saved SVG and its image refs.
  "scene"        jsonb,
  "scene_svg"    text,
  "file_refs"    jsonb,
  -- table: the workbook copy, relative to TABLE_DB_DIR; or the document of
  -- a table with no workbook.
  "table_path"   text,
  "table_doc"    jsonb,
  -- file: what the bytes were; the bytes themselves stay the brain's.
  "file_sha256"  text,
  "file_name"    text,
  "file_mime"    text,
  "file_size"    bigint,
  "accepted_at"  timestamptz NOT NULL DEFAULT now(),
  -- Written by this migration for a table or file it could not copy in SQL:
  -- completed on the author's first read.
  "pending"      boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
ALTER TABLE "public"."accepted_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Items accepted before this migration: their current saved version.
INSERT INTO "public"."accepted_snapshots"
  ("node_id", "kind", "title", "icon", "version", "doc", "content", "scene", "scene_svg",
   "file_refs", "table_doc", "file_sha256", "file_name", "file_mime", "file_size",
   "accepted_at", "pending")
SELECT n.id,
       n.type::text,
       n.title,
       nullif(n.data->>'icon', ''),
       CASE n.type::text WHEN 'page' THEN p.version WHEN 'draw' THEN d.version
                         WHEN 'table' THEN t.version END,
       CASE WHEN n.type::text = 'page' THEN p.doc END,
       CASE WHEN n.type::text = 'note' THEN coalesce(n.data->>'content', '') END,
       CASE WHEN n.type::text = 'draw' THEN d.scene END,
       CASE WHEN n.type::text = 'draw' THEN d.scene_svg END,
       CASE WHEN n.type::text = 'draw' THEN d.file_refs END,
       CASE WHEN n.type::text = 'table' AND t.storage_path IS NULL THEN t.data END,
       CASE WHEN n.type::text = 'file' THEN n.data->>'sha256' END,
       CASE WHEN n.type::text = 'file' THEN coalesce(n.data->>'filename', n.title) END,
       CASE WHEN n.type::text = 'file' THEN n.data->>'mime_type' END,
       CASE WHEN n.type::text = 'file' AND (n.data->>'size_bytes') ~ '^[0-9]+$'
            THEN (n.data->>'size_bytes')::bigint END,
       coalesce(si.accepted_at, si.updated_at, now()),
       (n.type::text = 'table' AND t.storage_path IS NOT NULL)
         OR (n.type::text = 'file' AND n.data->>'sha256' IS NULL)
  FROM "public"."space_items" si
  JOIN "public"."nodes" n ON n.id = si.node_id
  JOIN "public"."spaces" s ON s.id = n.owner_id AND s.kind = 'brain'
  LEFT JOIN "public"."pages" p ON p.node_id = n.id
  LEFT JOIN "public"."draws" d ON d.node_id = n.id
  LEFT JOIN "public"."tables" t ON t.node_id = n.id
 WHERE si.review_state = 'accepted'
   AND n.type::text IN ('page', 'note', 'draw', 'table', 'file')
ON CONFLICT ("node_id") DO NOTHING;
