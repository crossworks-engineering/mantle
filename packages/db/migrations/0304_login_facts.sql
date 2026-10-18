-- The login facts in SQL (workspaces arch plan v3.2, S2a a0): one SQL source
-- for each fact about a login that the area asks and the Admin asks read,
-- so the TypeScript copies of their text go (packages/db client.ts
-- loginHoldsAdmin and loginHasArea become calls of these). Answers stay as
-- they were, with one named exception (2).
--
-- 1. mantle_area_rule(login, area): THE area rule about a login. The
--    brain's live Admin workspace, an enabled login with a user row there,
--    a known area, and limits that do not switch the area off ('false').
--    loginHasArea's SQL, moved: its area list lived in TypeScript
--    (SCOPE_AREAS), here it is in the rule. For an ask about another login
--    (the maker of a tool, a vault pair, a Telegram chat) and for unscoped
--    system work.
-- 2. mantle_scope_has_area(area) (0256, 0291): mantle_area_rule for the
--    scope's own login (mantle_scope_login_id) AND the brain's Admin
--    workspace is in the scope (mantle_scope_ws). It keeps its "Admin in
--    the scope" test and gains the brain-owner and disabled_at tests, so it
--    is narrower: a disabled login inside a scope that is still open no
--    longer holds an area. That is the one changed answer. Every ask about
--    the scope's own login uses this one, never the bare rule (which skips
--    "Admin in the scope").
-- 3. mantle_login_area(login, area) (0293): "the brain has no Admin
--    workspace: yes" OR mantle_area_rule. That first branch is a fail-open
--    site (counted in S4a, removed in S4b); it stays here and nowhere else:
--    it never flows into mantle_scope_has_area or mantle_login_areas.
-- 4. mantle_login_areas(login): the areas mantle_area_rule gives the
--    login, in the order of SCOPE_AREAS; the strict rule only.
-- 5. mantle_login_is_admin(login): loginHoldsAdmin's SQL, moved, not
--    rewritten: an enabled login with a user row in the brain's live Admin
--    workspace (never the role alone).
-- 6. mantle_role_drift(): how many enabled logins, former clients
--    (archive_client_logins) left out, have a role that disagrees with
--    mantle_login_is_admin (role 'admin' outside Admin, or another role
--    inside it). A disabled login is left out: a disable keeps role 'admin'
--    (login-update.ts) while mantle_login_is_admin needs an enabled login.
--    A number for the box count (scripts/arch-scoreboard-box.sh).
--
-- Grants: PUBLIC loses EXECUTE on the new facts and no viewer role, the
-- write role or the gap writer gets it (on a scoped role a member could
-- probe whether any login id is Admin). The runtime role runs them from
-- its allowlist (packages/db runtime-role.ts RUNTIME_SYSTEM_FUNCTIONS);
-- the definers call them as their owner. mantle_scope_has_area and
-- mantle_login_area keep the rights they had (CREATE OR REPLACE keeps
-- them): the workspace role's policy helper, and none.
--
-- No table, row or trigger changes. Re-runnable: CREATE OR REPLACE only.
--
-- The number was claimed at the merge (plan v3.2 rule 3): R0 landed first
-- with 0301_check_mode_floor, S3 with 0302_write_role_gap_tables and the
-- S11a-7 hotfix with 0303_export_check_grant_branch (`when` 1790197500000);
-- this file is 0304 with the `when` it had as 0302 (1790197560000, above
-- 0303's).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_area_rule"(login uuid, area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."workspaces" w
      JOIN "public"."workspace_users" u ON u."workspace_id" = w."id" AND u."login_id" = login
      JOIN "auth"."users" l ON l."id" = u."login_id" AND l."disabled_at" IS NULL
     WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin"
       AND w."archived_at" IS NULL
       AND area IN ('settings', 'users', 'assistants', 'connectors', 'keys')
       AND coalesce(u."limits" -> 'areas' ->> area, '') <> 'false')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_area_rule"(uuid, text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_has_area"(area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_area_rule"("public"."mantle_scope_login_id"(), area)
     AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin"
                    AND w."archived_at" IS NULL
                    AND w."id" = ANY ("public"."mantle_scope_ws"()))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_area"(login uuid, area text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                      WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin")
      OR "public"."mantle_area_rule"(login, area)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_areas"(login uuid)
  RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT coalesce(array_agg(t.area ORDER BY t.o), '{}'::text[])
    FROM unnest(ARRAY['settings', 'users', 'assistants', 'connectors', 'keys'])
         WITH ORDINALITY AS t(area, o)
   WHERE "public"."mantle_area_rule"(login, t.area)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_login_areas"(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_is_admin"(login uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."workspaces" w
      JOIN "public"."workspace_users" u ON u."workspace_id" = w."id" AND u."login_id" = login
      JOIN "auth"."users" l ON l."id" = u."login_id" AND l."disabled_at" IS NULL
     WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin"
       AND w."archived_at" IS NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_login_is_admin"(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_role_drift"()
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT count(*)::int
    FROM "auth"."users" l
   WHERE l."disabled_at" IS NULL
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" a WHERE a."login_id" = l."id")
     AND coalesce(l."role" = 'admin', false) <> "public"."mantle_login_is_admin"(l."id")
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_role_drift"() FROM PUBLIC;
