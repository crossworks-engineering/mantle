-- Workspaces, phase W4b: assistant turns run on their workspace (plan page
-- 4887b8e7, sections 5.1, 5.4, 6, R3, S4, T4, U5; the CEO's W4 decisions of
-- 2026-10-10).
--
-- The Team assistant's turns move from the team level role onto the
-- workspace role (mantle_view_user) with the scope [Team]. That role needs a
-- read rule for every table such a turn touches. Every rule here is narrower
-- than or equal to what the team role reads today:
--  - configuration the loop reads (tools, skills, embedding and worker
--    settings, profiles, the owner anchor of auth.users): granted like the
--    team role (ACCESS_MATRIX, `user: 'level'`), no row secrecy;
--  - agents: an assistant of a workspace in the scope, or a helper (no
--    workspace). The team role reads every agent today;
--  - tool groups: never an adminOnly group outside the Admin workspace, and
--    a connector group only where it is a resource of a workspace in the
--    scope. The team role reads every group today;
--  - threads, messages, tool results, runs, run items and Pending (R3): the
--    rows of a workspace in the scope that belong to the scope's login. A row
--    with no login is Admin only (R3, until reads honour login), and a row
--    with no workspace is Admin's (the stamp trigger's NULL rule, 0250). The
--    team role reads none of these today.
--
-- adminOnly (plan 5.4): a tool group column, written from the manifest by
-- the boot reconcile and backfilled here for the shipped groups. An adminOnly
-- group runs only in a turn whose scope holds the Admin workspace.
--
-- Nothing here writes a grant, starts LLM work or notifies the extractor.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."tool_groups" ADD COLUMN IF NOT EXISTS "admin_only" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- The shipped adminOnly groups (MANIFEST_ADMIN_ONLY_GROUPS in the manifest;
-- manifest.test.ts pins the two lists together).
UPDATE "public"."tool_groups" SET "admin_only" = true
 WHERE "slug" IN ('email', 'journal', 'journal-admin', 'contacts', 'contacts-admin', 'secrets',
                  'events', 'tasks', 'team-read-admin', 'access', 'team-admin', 'runs', 'export',
                  'replay', 'replay-search', 'persona', 'model-curation', 'brain-health', 'ingest',
                  'federation', 'federation-write', 'messaging')
   AND NOT "admin_only";
--> statement-breakpoint

-- Whether a connector group is a resource of a workspace in the scope (plan
-- section 6). Security definer: the workspace role reads resources only with
-- a login, and an assistant turn without one (a heartbeat) must still see
-- the connectors of its own workspace, nothing more.
CREATE OR REPLACE FUNCTION "public"."mantle_scope_has_connector"(group_owner uuid, group_slug text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."workspace_resources" r
      JOIN "public"."workspaces" w ON w."id" = r."workspace_id"
     WHERE r."type" = 'connector' AND r."ref_id" = group_slug
       AND w."owner_id" = group_owner AND w."archived_at" IS NULL
       AND r."workspace_id" = ANY ("public"."mantle_scope_ws"()))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_scope_has_connector"(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_scope_has_connector"(uuid, text) TO mantle_view_user;
--> statement-breakpoint

-- Whether the scope holds the Admin workspace, for the rules below. Security
-- definer for the same reason (an assistant turn without a login).
CREATE OR REPLACE FUNCTION "public"."mantle_scope_is_admin"()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."workspaces" w
     WHERE w."is_admin" AND w."archived_at" IS NULL
       AND w."id" = ANY ("public"."mantle_scope_ws"()))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_scope_is_admin"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_scope_is_admin"() TO mantle_view_user;
--> statement-breakpoint

-- ── Agents and tool groups ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "agents_user_read" ON "public"."agents";
--> statement-breakpoint
CREATE POLICY "agents_user_read" ON "public"."agents" FOR SELECT TO mantle_view_user
  USING ("workspace_id" IS NULL
         OR "workspace_id" = ANY ((SELECT "public"."mantle_scope_ws"())::uuid[]));
--> statement-breakpoint
DROP POLICY IF EXISTS "tool_groups_user_read" ON "public"."tool_groups";
--> statement-breakpoint
CREATE POLICY "tool_groups_user_read" ON "public"."tool_groups" FOR SELECT TO mantle_view_user
  USING ((NOT "admin_only" OR (SELECT "public"."mantle_scope_is_admin"()))
         AND ("integration" IS NULL
              OR "public"."mantle_scope_has_connector"("owner_id", "slug")));
--> statement-breakpoint

-- ── Per-login stores (R3) ─────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_messages', 'chat_threads', 'tool_results', 'runs',
                           'run_items', 'pending_tool_calls'] LOOP
    EXECUTE format('ALTER TABLE "public".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON "public".%I', t || '_user_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON "public".%I FOR SELECT TO mantle_view_user USING ('
      '  (CASE WHEN "workspace_id" IS NULL THEN (SELECT "public"."mantle_scope_is_admin"())'
      '        ELSE "workspace_id" = ANY ((SELECT "public"."mantle_scope_ws"())::uuid[]) END)'
      '  AND (CASE WHEN "login_id" IS NULL THEN (SELECT "public"."mantle_scope_is_admin"())'
      '        ELSE "login_id" = (SELECT "public"."mantle_login_id"()) END))',
      t || '_user_read', t);
  END LOOP;
END
$$;
