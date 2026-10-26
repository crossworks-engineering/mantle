-- The canvas data store (DWG phase 7a; docs/proposals/canvas-files.md,
-- "The data store"). Small JSON values a Present canvas keeps through
-- `mantle.data`: meeting marks, saved layouts, suggestions, votes. A canvas
-- runs sandboxed with no network; its host page forwards each call to the
-- brain as the signed-in user, and binds the canvas.
--
-- One row per (canvas, key) in the `shared` bucket (login_id NULL), one per
-- (canvas, login, key) in `mine`. `bytes` is the size of the value's JSON
-- text, which the caps count (@mantle/content-core/canvas-data). NOT a canvas
-- revision: nothing here touches `presents` or its rev. A row goes with its
-- canvas (nodes cascade) and a `mine` row with its login.
--
-- Rights, on the canvas's own item rights:
--  - read (the row rule below, for the workspace role): a row of a canvas
--    the scope reads, when it is `shared`, or the scope's own `mine` entry,
--    or the scope may edit the canvas (Write on it: it reads everyone's
--    `mine` entries).
--  - write: the item_marks pattern (access matrix `scopedSystemWrite`): the
--    content layer (packages/content/src/canvas-data.ts) reads the canvas in
--    the caller's scope first, asks Write on it for `shared`, and writes only
--    the caller's own login for `mine`; then the system pool writes. The
--    write role holds no right on the table.
--
-- Grants come from the access matrix (applyViewerGrants), never from here.
-- Idempotent. Revert: packages/db/rollback/0335_canvas_data.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."canvas_data" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "bucket" text NOT NULL,
  "key" text NOT NULL,
  "login_id" uuid REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "value" jsonb NOT NULL,
  "bytes" integer NOT NULL,
  "updated_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "canvas_data_bucket_ck" CHECK (
    ("bucket" = 'shared' AND "login_id" IS NULL)
    OR ("bucket" = 'mine' AND "login_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvas_data_shared_key_uq"
  ON "public"."canvas_data" ("node_id", "key") WHERE "bucket" = 'shared';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvas_data_mine_key_uq"
  ON "public"."canvas_data" ("node_id", "login_id", "key") WHERE "bucket" = 'mine';
--> statement-breakpoint

LOCK TABLE "public"."canvas_data" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."canvas_data" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "canvas_data_user_read" ON "public"."canvas_data";
--> statement-breakpoint
CREATE POLICY "canvas_data_user_read" ON "public"."canvas_data" FOR SELECT TO mantle_view_user
  USING (EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = "canvas_data"."node_id"
       AND ("canvas_data"."bucket" = 'shared'
            OR "canvas_data"."login_id" = (SELECT "public"."mantle_login_id"())
            OR coalesce("public"."mantle_may_edit"(n."home_ws", n."write_ws"), false))));
