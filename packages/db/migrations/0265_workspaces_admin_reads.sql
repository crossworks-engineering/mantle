-- Workspaces W6a: an Admin user's reads run in the user's scope (plan page
-- 4887b8e7, sections 2.4, 11 and 14). The session guard enters the login's
-- workspace scope for the rest of a request, so the screens of brain items
-- read on the workspace role (mantle_view_user) instead of the system pool.
-- The access matrix (access-matrix.ts) now grants that role the tables those
-- screens read; this migration gives each of them its row rule. Row rules
-- only on items and what follows them (plan 14): nothing here widens a
-- level role (none of these tables is granted to one), and a member's scope
-- never holds the Admin workspace, so the Admin-only rows stay Admin's.
--
--  - rows of an item: visible when the item's row is (the nodes policy):
--    shares, node_snapshots, emails, item_marks, recall_maps,
--    app_access_log (by app_node_id); email_attachments by their email;
--    recall_nodes and recall_revisions by their map.
--  - the entity graph, the documentation collections and the mail accounts
--    (never their sealed credentials, a column the role is not granted): a
--    scope that holds the Admin workspace only (plan 2.2: only the Admin
--    workspace reads the graph and holds mail).
--  - spaces: the brain's row and the login's own personal space only.
--  - traces: stamped with a workspace since W4b (R3): a trace of a
--    workspace in the scope, or an unstamped one (system work, Admin by
--    the stamp rule) for a scope that holds the Admin workspace.
--
-- Each table gets row level security on. The system pool owns the tables
-- and is not held by it; no other role is granted them. Idempotent.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'shares', 'node_snapshots', 'emails', 'item_marks', 'recall_maps',
    'app_access_log', 'email_attachments', 'recall_nodes', 'recall_revisions',
    'entities', 'entity_edges', 'entity_merge_dismissals', 'doc_collections',
    'traces', 'email_accounts', 'spaces'
  ] LOOP
    EXECUTE format('ALTER TABLE "public".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON "public".%I', t || '_user_read', t);
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shares', 'node_snapshots', 'emails', 'item_marks', 'recall_maps'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON "public".%I FOR SELECT TO mantle_view_user '
      'USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = %I.node_id))',
      t || '_user_read', t, t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY "app_access_log_user_read" ON "public"."app_access_log" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "app_access_log"."app_node_id"));
--> statement-breakpoint
CREATE POLICY "email_attachments_user_read" ON "public"."email_attachments" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."emails" e WHERE e.id = "email_attachments"."email_id"));
--> statement-breakpoint
CREATE POLICY "recall_nodes_user_read" ON "public"."recall_nodes" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."recall_maps" m WHERE m.id = "recall_nodes"."map_id"));
--> statement-breakpoint
CREATE POLICY "recall_revisions_user_read" ON "public"."recall_revisions" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."recall_maps" m WHERE m.id = "recall_revisions"."map_id"));
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'entities', 'entity_edges', 'entity_merge_dismissals', 'doc_collections', 'email_accounts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON "public".%I FOR SELECT TO mantle_view_user '
      'USING ((SELECT "public"."mantle_scope_is_admin"()))',
      t || '_user_read', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY "traces_user_read" ON "public"."traces" FOR SELECT TO mantle_view_user
  USING (ARRAY["workspace_id"] && (SELECT "public"."mantle_scope_ws"())
         OR ("workspace_id" IS NULL AND (SELECT "public"."mantle_scope_is_admin"())));
--> statement-breakpoint
-- The brain's own space row and the login's own personal space (a tree
-- names the login's space to list its own items, which stay on the space
-- role until W6b). Never another login's.
CREATE POLICY "spaces_user_read" ON "public"."spaces" FOR SELECT TO mantle_view_user
  USING ("kind" = 'brain' OR "login_id" = (SELECT "public"."mantle_login_id"()));
