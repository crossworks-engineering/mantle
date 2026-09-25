-- Member logins Phase 0b: one level system + the access adapter's row rules
-- (plan section 2b/2c). INERT on its own: the app connects as the superuser,
-- which bypasses row level security, and nothing runs under a viewer role
-- until the owner turns enforcement on. The viewer roles themselves are made
-- by ensureViewerRoles (packages/db/src/viewer-roles.ts), which migrate runs
-- BEFORE this file; their GRANTs come from the access matrix
-- (packages/db/src/access-matrix.ts), applied after the migrations.

-- ── Levels ───────────────────────────────────────────────────────────────────
-- admin > team > client > public. Default admin, lowered only by hand.

-- The workspace kinds: the only node types that may go below admin. Every
-- other kind (journal, email, contact, secret, task, event, …) is admin
-- forever. One definition, used by the CHECK and by the row policy; the TS
-- mirror (WORKSPACE_NODE_TYPES) is pinned to it by access-matrix.db.test.ts.
CREATE OR REPLACE FUNCTION "public"."mantle_workspace_kind"(t "public"."node_type")
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app')
$$;
--> statement-breakpoint

ALTER TABLE "public"."nodes"
  ADD COLUMN IF NOT EXISTS "audience" text NOT NULL DEFAULT 'admin';
--> statement-breakpoint
-- NOT VALID here, VALIDATE in 0160 (its own transaction, short lock).
ALTER TABLE "public"."nodes"
  ADD CONSTRAINT "nodes_audience_ck"
  CHECK ("audience" IN ('admin', 'team', 'client', 'public')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."nodes"
  ADD CONSTRAINT "nodes_audience_kind_ck"
  CHECK ("audience" = 'admin' OR "public"."mantle_workspace_kind"("type")) NOT VALID;
--> statement-breakpoint

-- An agent's level decides who may chat with it AND what it reads.
ALTER TABLE "public"."agents"
  ADD COLUMN IF NOT EXISTS "audience" text NOT NULL DEFAULT 'admin';
--> statement-breakpoint
ALTER TABLE "public"."agents"
  ADD CONSTRAINT "agents_audience_ck"
  CHECK ("audience" IN ('admin', 'team', 'client', 'public')) NOT VALID;
--> statement-breakpoint

-- A tool group's level: an agent may hold only groups at or below its level.
ALTER TABLE "public"."tool_groups"
  ADD COLUMN IF NOT EXISTS "audience" text NOT NULL DEFAULT 'admin';
--> statement-breakpoint
ALTER TABLE "public"."tool_groups"
  ADD CONSTRAINT "tool_groups_audience_ck"
  CHECK ("audience" IN ('admin', 'team', 'client', 'public')) NOT VALID;
--> statement-breakpoint

-- ── Row rules for the viewer roles ──────────────────────────────────────────

-- The brain's owner id. Today the anchor login; Phase 2 reads spaces.
CREATE OR REPLACE FUNCTION "public"."mantle_brain_id"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT id FROM auth.users WHERE is_owner ORDER BY created_at LIMIT 1
$$;
--> statement-breakpoint

-- The audiences the CURRENT role may read. Inlinable SQL keyed on
-- current_user: the admin pool (superuser) bypasses the policies anyway.
CREATE OR REPLACE FUNCTION "public"."mantle_viewer_audiences"()
  RETURNS text[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE current_user
    WHEN 'mantle_view_team'   THEN ARRAY['team', 'client', 'public']
    WHEN 'mantle_view_client' THEN ARRAY['client', 'public']
    WHEN 'mantle_view_public' THEN ARRAY['public']
    ELSE ARRAY[]::text[]
  END
$$;
--> statement-breakpoint

-- Brain items: the brain's own, at or below the viewer's level, workspace
-- kinds only. Without the owner check a member's personal item at 'team'
-- would match (Phase 2).
ALTER TABLE "public"."nodes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "nodes_viewer_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING ("owner_id" = "public"."mantle_brain_id"()
         AND "audience" = ANY ("public"."mantle_viewer_audiences"())
         AND "public"."mantle_workspace_kind"("type"));
--> statement-breakpoint

-- Everything derived from a node follows it: the nodes policy applies inside
-- the EXISTS, so there is one rule, not six.
ALTER TABLE "public"."content_chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "content_chunks_viewer_read" ON "public"."content_chunks" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "content_chunks"."node_id"));
--> statement-breakpoint
-- A fact with no source came from the owner's own chats: admin only.
ALTER TABLE "public"."facts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "facts_viewer_read" ON "public"."facts" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING ("source_node_id" IS NOT NULL
         AND EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "facts"."source_node_id"));
--> statement-breakpoint
ALTER TABLE "public"."pages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pages_viewer_read" ON "public"."pages" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "pages"."node_id"));
--> statement-breakpoint
ALTER TABLE "public"."draws" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "draws_viewer_read" ON "public"."draws" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "draws"."node_id"));
--> statement-breakpoint
ALTER TABLE "public"."tables" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tables_viewer_read" ON "public"."tables" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "tables"."node_id"));
--> statement-breakpoint
ALTER TABLE "public"."apps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "apps_viewer_read" ON "public"."apps" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "apps"."node_id"));
--> statement-breakpoint
ALTER TABLE "public"."app_databases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app_databases_viewer_read" ON "public"."app_databases" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "app_databases"."app_node_id"));
--> statement-breakpoint

-- ── Starting levels (plan 2c migration) ────────────────────────────────────
-- Today's sharing, carried over so nothing a team member can see now
-- disappears when enforcement is turned on. Workspace kinds only: a shared
-- task or event stays admin (the shadow report lists them).
UPDATE "public"."nodes" n SET "audience" = 'team'
  FROM "public"."shares" s
  WHERE s.node_id = n.id AND s.revoked_at IS NULL
    AND (s.expires_at IS NULL OR s.expires_at > now())
    AND s.settings->>'mode' = 'team'
    AND "public"."mantle_workspace_kind"(n.type) AND n.audience = 'admin';
--> statement-breakpoint
UPDATE "public"."nodes" n SET "audience" = 'public'
  FROM "public"."shares" s
  WHERE s.node_id = n.id AND s.revoked_at IS NULL
    AND (s.expires_at IS NULL OR s.expires_at > now())
    AND (s.settings->>'mode') IS DISTINCT FROM 'team'
    AND "public"."mantle_workspace_kind"(n.type);
--> statement-breakpoint
-- A shared folder's contents come with it (the same closure the Access
-- control offers as one explicit click). Only ever LOWERS admin rows.
UPDATE "public"."nodes" c SET "audience" = f.audience
  FROM "public"."nodes" f
  WHERE f.type = 'branch' AND f.audience <> 'admin'
    AND c.owner_id = f.owner_id AND c.id <> f.id
    AND c.path <@ f.path
    AND "public"."mantle_workspace_kind"(c.type) AND c.audience = 'admin';
--> statement-breakpoint
-- The member-facing agent and its tool groups.
UPDATE "public"."agents" SET "audience" = 'team' WHERE "slug" = 'team-responder';
--> statement-breakpoint
UPDATE "public"."tool_groups" SET "audience" = 'team' WHERE "slug" IN ('team-read', 'formulas-eval');
