-- Workspaces, phase W5b1 (plan page 4887b8e7, section 18 S2): reads that
-- decide "does the Team workspace read this item" ask the grants, not the
-- level columns.
--
-- The bridge (0251) is still on, so on a migrated brain the Team grant of a
-- brain item equals the team role's level rule (mantle_team_reads) and the
-- answer does not change. Two kinds of rows have no grants yet and keep the
-- level rule, in this ONE place:
--   - every row of a brain that was never migrated (mantle_ws_migrate skips
--     a brain that has client logins or client items, and a database whose
--     owner signs up after the migrations ran);
--   - personal-space rows (home_ws is NULL until W6b moves them in).
-- W5b2 (bridge off) and W6b remove the fallback; the level-reads sweep
-- (eslint-rules/level-reads.mjs) keeps every other product read of the level
-- columns out.
--
-- Nothing here writes a row, starts LLM work or notifies the extractor.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- The brain's Team workspace (the bridge-owned one), or NULL on a brain that
-- was never migrated. Called once per query as an init plan:
-- (SELECT mantle_brain_team_ws()). Definer: the level roles cannot read
-- workspaces; it hands out one id that every login of the brain may know.
CREATE OR REPLACE FUNCTION "public"."mantle_brain_team_ws"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT w."id" FROM "public"."workspaces" w
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'team'
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_brain_team_ws"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_brain_team_ws"()
  TO mantle_view_team, mantle_view_client, mantle_view_public, mantle_view_space, mantle_view_user;
--> statement-breakpoint
-- The public demo's SELECT-only reader serves owner reads (the app sidebar):
-- it gets the same, as it got mantle_brain_id (0189).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_brain_team_ws"() TO demo_reader;
  END IF;
END
$$;
--> statement-breakpoint

-- Does the Team workspace read this item? The grant when the item has one
-- (a brain item of a migrated brain: home_ws set), else the level rule
-- (mantle_team_reads, apps without their embeds: an embed never opens an
-- app's data, old trap 2). Pure, so the planner inlines it.
CREATE OR REPLACE FUNCTION "public"."mantle_item_team_reads"(
  read_ws uuid[], home_ws uuid, t "public"."node_type",
  audience text, inherited text, embedded text, team uuid)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN team IS NOT NULL AND home_ws IS NOT NULL THEN coalesce(team = ANY (read_ws), false)
    ELSE "public"."mantle_team_reads"(t, audience, inherited,
           CASE WHEN t = 'app' THEN NULL ELSE embedded END)
  END
$$;
--> statement-breakpoint

-- Whether the current workspace scope may do an "Admin only" thing in `area`
-- (plan S2: "Admin only" checks become scopeHasArea): the scope holds the
-- Admin workspace, its login is a user there, and that user's limits do not
-- switch the area off. The same rule as areasFor (server/web/lib/workspaces.ts)
-- for code that runs in a scope; an assistant turn (no login) has no area.
-- Definer: the workspace role does not read workspace_users.limits.
CREATE OR REPLACE FUNCTION "public"."mantle_scope_has_area"(area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."workspaces" w
      JOIN "public"."workspace_users" u
        ON u."workspace_id" = w."id" AND u."login_id" = "public"."mantle_login_id"()
     WHERE w."is_admin" AND w."archived_at" IS NULL
       AND w."id" = ANY ("public"."mantle_scope_ws"())
       AND area IN ('settings', 'users', 'assistants', 'connectors', 'keys')
       AND coalesce(u."limits" -> 'areas' ->> area, '') <> 'false')
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_scope_has_area"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_scope_has_area"(text) TO mantle_view_user;
