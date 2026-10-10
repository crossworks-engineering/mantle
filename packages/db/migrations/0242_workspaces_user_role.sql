-- Workspaces, phase W1: row security for the ONE new login role,
-- mantle_view_user (plan section 2). Nothing logs in as it yet: withScope
-- (@mantle/db) is used by tests only until later phases. The grants come
-- from ACCESS_MATRIX (`user` column), applied by applyViewerGrants after
-- the migrations; ensureViewerRoles creates the role before them.
--
-- The read rule is one array overlap on the row itself (section 3): the
-- row's workspaces meet the scope's, and a per-login row (a chat, a fact
-- learned from a chat) is read only by its own login (S4). No owner term
-- and no kind term: an item a workspace may not hold has no grant to it.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

DROP POLICY IF EXISTS "nodes_user_read" ON "public"."nodes";
--> statement-breakpoint
CREATE POLICY "nodes_user_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_user
  USING ("read_ws" && (SELECT "public"."mantle_scope_ws"())
         AND ("login_id" IS NULL OR "login_id" = (SELECT "public"."mantle_login_id"())));
--> statement-breakpoint

DROP POLICY IF EXISTS "content_chunks_user_read" ON "public"."content_chunks";
--> statement-breakpoint
CREATE POLICY "content_chunks_user_read" ON "public"."content_chunks" FOR SELECT
  TO mantle_view_user
  USING ("read_ws" && (SELECT "public"."mantle_scope_ws"())
         AND ("login_id" IS NULL OR "login_id" = (SELECT "public"."mantle_login_id"())));
--> statement-breakpoint

DROP POLICY IF EXISTS "content_chunk_windows_user_read" ON "public"."content_chunk_windows";
--> statement-breakpoint
CREATE POLICY "content_chunk_windows_user_read" ON "public"."content_chunk_windows" FOR SELECT
  TO mantle_view_user
  USING ("read_ws" && (SELECT "public"."mantle_scope_ws"())
         AND ("login_id" IS NULL OR "login_id" = (SELECT "public"."mantle_login_id"())));
--> statement-breakpoint

DROP POLICY IF EXISTS "facts_user_read" ON "public"."facts";
--> statement-breakpoint
CREATE POLICY "facts_user_read" ON "public"."facts" FOR SELECT
  TO mantle_view_user
  USING ("read_ws" && (SELECT "public"."mantle_scope_ws"())
         AND ("login_id" IS NULL OR "login_id" = (SELECT "public"."mantle_login_id"())));
--> statement-breakpoint

-- Rows that follow their node: the node's own rule decides.
DROP POLICY IF EXISTS "pages_user_read" ON "public"."pages";
--> statement-breakpoint
CREATE POLICY "pages_user_read" ON "public"."pages" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "pages"."node_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "draws_user_read" ON "public"."draws";
--> statement-breakpoint
CREATE POLICY "draws_user_read" ON "public"."draws" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "draws"."node_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "tables_user_read" ON "public"."tables";
--> statement-breakpoint
CREATE POLICY "tables_user_read" ON "public"."tables" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "tables"."node_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "apps_user_read" ON "public"."apps";
--> statement-breakpoint
CREATE POLICY "apps_user_read" ON "public"."apps" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "apps"."node_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "app_databases_user_read" ON "public"."app_databases";
--> statement-breakpoint
CREATE POLICY "app_databases_user_read" ON "public"."app_databases" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "app_databases"."app_node_id"));
--> statement-breakpoint

-- The model itself: a user sees the workspaces in their scope, the people
-- in them, their resources, and the grants of the items they read.
ALTER TABLE "public"."workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."workspace_users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."item_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."workspace_resources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."workspace_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."node_acl_head" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."heads_check_misses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "workspaces_user_read" ON "public"."workspaces";
--> statement-breakpoint
CREATE POLICY "workspaces_user_read" ON "public"."workspaces" FOR SELECT TO mantle_view_user
  USING ("id" = ANY ((SELECT "public"."mantle_scope_ws"())::uuid[]));
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_users_user_read" ON "public"."workspace_users";
--> statement-breakpoint
CREATE POLICY "workspace_users_user_read" ON "public"."workspace_users" FOR SELECT TO mantle_view_user
  USING ("workspace_id" = ANY ((SELECT "public"."mantle_scope_ws"())::uuid[]));
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_resources_user_read" ON "public"."workspace_resources";
--> statement-breakpoint
CREATE POLICY "workspace_resources_user_read" ON "public"."workspace_resources" FOR SELECT TO mantle_view_user
  USING ("workspace_id" = ANY ((SELECT "public"."mantle_scope_ws"())::uuid[]));
--> statement-breakpoint
DROP POLICY IF EXISTS "item_grants_user_read" ON "public"."item_grants";
--> statement-breakpoint
CREATE POLICY "item_grants_user_read" ON "public"."item_grants" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "item_grants"."node_id"));
