-- Client logins C5: client drafts, requests and comments (plan sections 3.2,
-- 6, 7, 9; decisions 5 B and 8).
--
-- 1. space_items.author_role: the author's role, stamped when the row is
--    made and never changed. An item ACCEPTED from a client's space moves
--    into the brain; the lowering guard (packages/tools/src/client-sourced.ts)
--    must still know a client wrote it after the client login is deleted
--    (author_login_id goes NULL then). Written by a trigger from auth.users,
--    never by the app, and kept by a second trigger on every update.
--
-- 2. Client requests for members (decision 5 B): a client's SUBMITTED items
--    (and the items submitted in their bundle) are readable by the TEAM role
--    with mantle.human on (a member's own request, never an agent), published
--    columns only (the pages, draws, tables and chunks rules follow nodes).
--    A client's draft, returned or accepted item never matches. The Team
--    drafts rules are unchanged: mantle_member_space() is member-only, so a
--    client's space never shows there.
--
-- 3. Comments in a CLIENT's own space: the client reads only the review
--    talk (thread_scope 'review') written by a reviewer (author_kind 'owner')
--    or by the client itself, never a member's comment. A client writes its
--    own comments as author_kind 'client', review scope only. Members and
--    admins keep the 0168/0171 rules.
--
-- 4. The client thread on a client-level BRAIN item (decision 8): comments
--    with thread_scope 'client'. The client role and the team role (human
--    flag on) read them while the item is a brain item at client level;
--    nothing below admin reads a 'client' thread on any other item, and the
--    other scopes stay as they were. The level roles never write: the app
--    writes on the admin pool with the item's level checked in the same
--    statement (packages/content/src/client-thread.ts).
--
-- 5. space_submissions: one row per Submit, per space (a ledger like
--    space_uploads, 0169), so the client caps (10 submissions a day) cannot
--    be reset by Recall and Submit again. The space role inserts and reads
--    its own space's rows; no update or delete rule (grants come from the
--    access matrix at migrate).
--
-- 6. mantle_client_space_bytes(): the bytes all client spaces hold together
--    (files and table workbooks), for the brain-wide client total (plan 9,
--    N12). Security definer: a client's space role reads no other space. It
--    answers one number.
--
-- Rollback: the previous release runs on this schema. It never reads the
-- new column or table; its comment inserts name 'team' or 'review' only.
-- Its client space role would write author_kind 'member' comments, which
-- the new insert rule refuses; no client space route exists before C5.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- ── 1. space_items.author_role ──────────────────────────────────────────────
ALTER TABLE "public"."space_items" ADD COLUMN IF NOT EXISTS "author_role" text;
--> statement-breakpoint
UPDATE "public"."space_items" si SET "author_role" = u.role
  FROM "auth"."users" u
 WHERE u.id = si."author_login_id" AND si."author_role" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_space_item_author_role"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.author_role := (SELECT u.role FROM auth.users u WHERE u.id = NEW.author_login_id);
  ELSE
    -- Never changed after the row is made (the space role may update its
    -- own rows; this column is not its to set).
    NEW.author_role := OLD.author_role;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_space_item_author_role"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "space_items_author_role" ON "public"."space_items";
--> statement-breakpoint
CREATE TRIGGER "space_items_author_role"
  BEFORE INSERT OR UPDATE ON "public"."space_items"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_space_item_author_role"();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_items_client_author_idx"
  ON "public"."space_items" ("node_id") WHERE "author_role" = 'client';
--> statement-breakpoint

-- ── 2. Client requests: a client's submitted items, for members ────────────
-- A personal space whose login is a client.
CREATE OR REPLACE FUNCTION "public"."mantle_client_space"(space uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."spaces" s
      JOIN "auth"."users" u ON u.id = s.login_id
     WHERE s.id = space AND s.kind = 'personal' AND u.role = 'client')
$$;
--> statement-breakpoint
-- A node in a client's space that is submitted for review, or was submitted
-- in the bundle of a submitted item (0180). By node, security definer: the
-- nodes rule cannot read space_items itself without recursing.
CREATE OR REPLACE FUNCTION "public"."mantle_client_request_node"(node uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = node
       AND "public"."mantle_client_space"(n.owner_id)
       AND (EXISTS (SELECT 1 FROM "public"."space_items" si
                     WHERE si.node_id = n.id AND si.review_state = 'submitted')
            OR EXISTS (SELECT 1 FROM "public"."space_item_bundles" b
                         JOIN "public"."space_items" r ON r.node_id = b.root_id
                        WHERE b.node_id = n.id AND r.review_state = 'submitted')))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_client_space"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_client_space"(uuid)
  TO mantle_view_team, mantle_view_space;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_client_request_node"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_client_request_node"(uuid) TO mantle_view_team;
--> statement-breakpoint
DROP POLICY IF EXISTS "nodes_client_requests_read" ON "public"."nodes";
--> statement-breakpoint
CREATE POLICY "nodes_client_requests_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_team
  USING (coalesce(current_setting('mantle.human', true), '') = 'on'
         AND "owner_id" IS DISTINCT FROM (SELECT "public"."mantle_brain_id"())
         AND "public"."mantle_workspace_kind"("type")
         AND "public"."mantle_client_request_node"("id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "space_items_client_requests_read" ON "public"."space_items";
--> statement-breakpoint
CREATE POLICY "space_items_client_requests_read" ON "public"."space_items" FOR SELECT
  TO mantle_view_team
  USING (coalesce(current_setting('mantle.human', true), '') = 'on'
         AND "public"."mantle_client_request_node"("node_id"));
--> statement-breakpoint

-- ── 3. Comments in a client's own space ─────────────────────────────────────
ALTER TABLE "public"."node_comments" DROP CONSTRAINT IF EXISTS "node_comments_thread_scope_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_comments" ADD CONSTRAINT "node_comments_thread_scope_ck"
  CHECK ("thread_scope" IN ('team', 'review', 'client'));
--> statement-breakpoint
DROP POLICY IF EXISTS "node_comments_space_read" ON "public"."node_comments";
--> statement-breakpoint
CREATE POLICY "node_comments_space_read" ON "public"."node_comments" FOR SELECT
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id")
         AND (NOT "public"."mantle_client_space"("public"."mantle_space_id"())
              OR ("thread_scope" = 'review'
                  AND ("author_kind" = 'owner'
                       OR ("author_kind" = 'client'
                           AND "login_id" = "public"."mantle_login_id"())))));
--> statement-breakpoint
DROP POLICY IF EXISTS "node_comments_space_insert" ON "public"."node_comments";
--> statement-breakpoint
CREATE POLICY "node_comments_space_insert" ON "public"."node_comments" FOR INSERT
  TO mantle_view_space
  WITH CHECK (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id")
              AND "login_id" = "public"."mantle_login_id"()
              AND "public"."mantle_is_brain_space"("owner_id")
              AND CASE WHEN "public"."mantle_client_space"("public"."mantle_space_id"())
                       THEN "author_kind" = 'client' AND "thread_scope" = 'review'
                       ELSE "author_kind" = 'member' AND "thread_scope" IN ('team', 'review')
                  END);
--> statement-breakpoint
DROP POLICY IF EXISTS "node_comments_space_update" ON "public"."node_comments";
--> statement-breakpoint
CREATE POLICY "node_comments_space_update" ON "public"."node_comments" FOR UPDATE
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id")
         AND "login_id" = "public"."mantle_login_id"())
  WITH CHECK (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "node_comments"."node_id")
              AND "login_id" = "public"."mantle_login_id"()
              AND "public"."mantle_is_brain_space"("owner_id")
              AND CASE WHEN "public"."mantle_client_space"("public"."mantle_space_id"())
                       THEN "author_kind" = 'client' AND "thread_scope" = 'review'
                       ELSE "author_kind" = 'member' AND "thread_scope" IN ('team', 'review')
                  END);
--> statement-breakpoint

-- ── 4. The client thread on a client-level brain item (decision 8) ─────────
DROP POLICY IF EXISTS "node_comments_client_thread_read" ON "public"."node_comments";
--> statement-breakpoint
CREATE POLICY "node_comments_client_thread_read" ON "public"."node_comments" FOR SELECT
  TO mantle_view_team, mantle_view_client
  USING (coalesce(current_setting('mantle.human', true), '') = 'on'
         AND "thread_scope" = 'client'
         AND EXISTS (SELECT 1 FROM "public"."nodes" n
                      WHERE n.id = "node_comments"."node_id"
                        AND n.audience = 'client'
                        AND n.owner_id = (SELECT "public"."mantle_brain_id"())));
--> statement-breakpoint

-- ── 5. The submission ledger ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."space_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "public"."spaces"("id") ON DELETE CASCADE,
  "node_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_submissions_space_time_idx"
  ON "public"."space_submissions" ("space_id", "created_at");
--> statement-breakpoint
ALTER TABLE "public"."space_submissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "space_submissions_space_read" ON "public"."space_submissions";
--> statement-breakpoint
CREATE POLICY "space_submissions_space_read" ON "public"."space_submissions" FOR SELECT
  TO mantle_view_space
  USING ("space_id" = "public"."mantle_space_id"());
--> statement-breakpoint
DROP POLICY IF EXISTS "space_submissions_space_insert" ON "public"."space_submissions";
--> statement-breakpoint
CREATE POLICY "space_submissions_space_insert" ON "public"."space_submissions" FOR INSERT
  TO mantle_view_space
  WITH CHECK ("space_id" = "public"."mantle_space_id"());
--> statement-breakpoint

-- ── 6. The bytes all client spaces hold ─────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."mantle_client_space_bytes"()
  RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT sum((n.data->>'size_bytes')::bigint)
                     FROM "public"."nodes" n
                    WHERE n.type = 'file' AND "public"."mantle_client_space"(n.owner_id)), 0)
       + coalesce((SELECT sum(t.size_bytes)
                     FROM "public"."tables" t
                     JOIN "public"."nodes" n ON n.id = t.node_id
                    WHERE "public"."mantle_client_space"(n.owner_id)), 0)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_client_space_bytes"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_client_space_bytes"() TO mantle_view_space;
