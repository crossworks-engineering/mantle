-- Client logins, Phase C1: the client level, ready and dark.
--
-- A client login is a person at the brain's one client company. It reads
-- brain items at level client through the existing mantle_view_client role.
-- Nothing here makes a client login: the users API still refuses role
-- client until Phase C2. What changes:
--
--  1. auth.users.role admits 'client' (the anchor stays admin).
--  2. The client role reads CLIENT items only, not public ones (decision 3):
--     migration 0161 set every item with an open link, and a shared
--     folder's contents, to public, so on a real box public means "every
--     item ever link-shared with an outsider". Public items stay reachable
--     by their own open link. In the database, so no search arm can forget.
--  3. The client role reads agents and tool groups at client level and
--     below only (a row rule for that role alone). The team role keeps every
--     row: invoke_agent and the delegate roster load admin agents under a
--     team viewer, and a team-level agent still delegates to one.
--  4. mantle_brain_id() is SECURITY DEFINER, so the client role needs no
--     grant on auth.users at all (the grant matrix drops it). The nodes
--     read rule calls it once per query, as an init plan.
--  5. client_report_acks: the admin's acknowledgement of the "What clients
--     see" report (Add client stays disabled until one exists, Phase C2).
--  6. The team-drafts read rule, same meaning, without a brain-id call per
--     hidden row (found by the C1 spike; the team role only).
--
-- Rollback: forward only for the policies (the pre-roll dump is the way
-- back). The previous code runs on these rules unchanged: it never makes a
-- client row and never runs a client viewer.

-- Short locks only: the role CHECK, the policies and ENABLE ROW LEVEL
-- SECURITY take exclusive locks on auth.users, nodes, agents and
-- tool_groups. A busy box waits at most 30 s for one, then this migration
-- fails and the roll stops, rather than queueing every reader behind it.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- ── 1. The role ─────────────────────────────────────────────────────────────
ALTER TABLE "auth"."users" DROP CONSTRAINT IF EXISTS "users_role_ck";
--> statement-breakpoint
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_role_ck"
  CHECK ("role" IN ('admin', 'member', 'client') AND (NOT "is_owner" OR "role" = 'admin'));
--> statement-breakpoint

-- ── 2. The client role reads client items only ──────────────────────────────
CREATE OR REPLACE FUNCTION "public"."mantle_viewer_audiences"()
  RETURNS text[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE current_user
    WHEN 'mantle_view_team'   THEN ARRAY['team', 'client', 'public']
    WHEN 'mantle_view_client' THEN ARRAY['client']
    WHEN 'mantle_view_public' THEN ARRAY['public']
    ELSE ARRAY[]::text[]
  END
$$;
--> statement-breakpoint

-- ── 4. The brain id without a grant on logins ───────────────────────────────
-- Answers one uuid and reads nothing else. A SECURITY DEFINER function is
-- never inlined, so the nodes rule below calls it through a scalar subquery:
-- one call per query, not one per row.
CREATE OR REPLACE FUNCTION "public"."mantle_brain_id"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT id FROM auth.users WHERE is_owner ORDER BY created_at LIMIT 1
$$;
--> statement-breakpoint
DROP POLICY IF EXISTS "nodes_viewer_read" ON "public"."nodes";
--> statement-breakpoint
CREATE POLICY "nodes_viewer_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING ("owner_id" = (SELECT "public"."mantle_brain_id"())
         AND "audience" = ANY ("public"."mantle_viewer_audiences"())
         AND "public"."mantle_workspace_kind"("type"));
--> statement-breakpoint

-- The team-drafts rule (0179), same meaning, cheaper: on a connection that
-- never set mantle.human, `current_setting(...) = 'on'` is NULL, not false,
-- so the rule did not stop early and called mantle_brain_id() once for every
-- workspace row the team role may not read (the C1 spike measured 318 calls
-- per scan on a copy of the dev brain). coalesce makes it false at once, and
-- the scalar subquery calls the brain id once per query.
DROP POLICY IF EXISTS "nodes_team_drafts_read" ON "public"."nodes";
--> statement-breakpoint
CREATE POLICY "nodes_team_drafts_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_team
  USING (coalesce(current_setting('mantle.human', true), '') = 'on'
         AND "owner_id" IS DISTINCT FROM (SELECT "public"."mantle_brain_id"())
         AND "public"."mantle_workspace_kind"("type")
         AND "public"."mantle_member_space"("owner_id")
         AND EXISTS (SELECT 1 FROM "public"."space_items" si
                      WHERE si.node_id = "nodes"."id" AND si.sharing = 'team'));
--> statement-breakpoint

-- ── 3. Agents and tool groups by level, for the client role only ────────────
ALTER TABLE "public"."agents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agents_viewer_read" ON "public"."agents";
--> statement-breakpoint
CREATE POLICY "agents_viewer_read" ON "public"."agents" FOR SELECT
  TO mantle_view_team, mantle_view_public
  USING (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "agents_client_read" ON "public"."agents";
--> statement-breakpoint
CREATE POLICY "agents_client_read" ON "public"."agents" FOR SELECT
  TO mantle_view_client
  USING ("audience" IN ('client', 'public'));
--> statement-breakpoint
ALTER TABLE "public"."tool_groups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tool_groups_viewer_read" ON "public"."tool_groups";
--> statement-breakpoint
CREATE POLICY "tool_groups_viewer_read" ON "public"."tool_groups" FOR SELECT
  TO mantle_view_team, mantle_view_public
  USING (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "tool_groups_client_read" ON "public"."tool_groups";
--> statement-breakpoint
CREATE POLICY "tool_groups_client_read" ON "public"."tool_groups" FOR SELECT
  TO mantle_view_client
  USING ("audience" IN ('client', 'public'));
--> statement-breakpoint

-- ── 5. The "What clients see" acknowledgement ───────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."client_report_acks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL,
  "acked_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "acked_at" timestamptz NOT NULL DEFAULT now(),
  "item_ids" uuid[] NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_report_acks_owner_idx"
  ON "public"."client_report_acks" ("owner_id", "acked_at");
