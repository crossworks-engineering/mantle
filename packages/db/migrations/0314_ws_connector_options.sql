-- The connectors a workspace may hold, as the workspace screen's "add
-- connector" list reads them: every tool group the attach definer
-- (mantle_ws_resource_add, 0307) accepts, an MCP connector and an HTTP API
-- connector alike. The list read the MCP connectors only (the settings
-- screen's /api/mcp-connectors), so a connector over an HTTP API could be
-- attached by the definer but was never offered.
--
-- mantle_ws_connector_options(ws): for each tool group of this brain with
-- an integration (THE rule of mantle_ws_resource_add: `owner_id` the brain,
-- `integration IS NOT NULL`, nothing else), its slug, name, kind ('mcp'
-- when `integration.mcp` is an object, else 'api') and whether `ws`
-- already holds it (held). Only for the scope's own login with the
-- connectors area (mantle_scope_has_area, as the attach asks) on a
-- workspace it may see (a user of it, or the users area, as
-- mantle_ws_resource_rows of 0291 answers); otherwise, and with no scope
-- (the system pool, a public link), no row. No binding, URL, secret
-- pointer or tool list is answered.
--
-- The list and the attach must never drift: ws-connector-options-0314.db.test.ts
-- pins that every slug it answers is one the attach accepts and every tool
-- group the attach accepts is on it (an MCP and an API connector, and a
-- plain tool group that is neither).
--
-- A fixed search_path (pg_temp last), no right for PUBLIC, EXECUTE for the
-- workspace role (the write and runtime roles follow it, as for 0291's
-- definers). No table, row, trigger or earlier function changes.
-- Re-runnable. The `when` sits above 0313's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_connector_options"(ws uuid)
  RETURNS TABLE ("slug" text, "name" text, "kind" text, "held" boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT g."slug", g."name",
         CASE WHEN jsonb_typeof(g."integration" -> 'mcp') = 'object' THEN 'mcp' ELSE 'api' END,
         EXISTS (SELECT 1 FROM "public"."workspace_resources" r
                  WHERE r."workspace_id" = w."id" AND r."type" = 'connector'
                    AND r."ref_id" = g."slug")
    FROM "public"."workspaces" w
    JOIN "public"."tool_groups" g ON g."owner_id" = w."owner_id"
   WHERE w."id" = ws AND w."owner_id" = "public"."mantle_brain_id"()
     -- The attach's rule (mantle_ws_resource_add, 0307), word for word.
     AND g."integration" IS NOT NULL
     -- Who may read it: the scope's own login with the connectors area
     -- (false with no scope or no login: the area needs the scope to hold
     -- the live Admin workspace and the login a seat there), on a
     -- workspace it may see.
     AND "public"."mantle_scope_has_area"('connectors')
     AND (ws = ANY ("public"."mantle_scope_ws"()) OR "public"."mantle_scope_has_area"('users'))
   ORDER BY lower(g."name"), g."slug"
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_connector_options"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_connector_options"(uuid) TO "mantle_view_user";
