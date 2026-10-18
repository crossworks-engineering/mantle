-- The Admin login is role AND membership (workspaces arch plan v3.2, S8a):
-- the SQL role read mantle_login_is_admin_user (0293) asks the same pair
-- the session guard asks since S8a (session.ts adminLogin: role admin AND
-- mantle_login_is_admin, read with the login row in loadLoginRow).
--
-- mantle_login_is_admin_user(login): its 0293 text, moved verbatim (role
-- 'admin', not disabled), AND mantle_login_is_admin(login) (0304: a user
-- of the brain's live Admin workspace, the login enabled). It only ANDs a
-- second condition, so it narrows: a role=admin login outside Admin is no
-- Admin user here either. Its readers follow. mantle_access_keys_seen's
-- every-key ask (login NULL: the key list route asks it for an admin-kind
-- caller, in the caller's own scope) answers such a login no key (before:
-- every key); unscoped it asks no login and answers every key, as before.
-- mantle_access_key_revoke lets it revoke only its own keys (before: any).
-- On a box with no role drift (mantle_role_drift() = 0, the S8a
-- precondition) no answer changes.
--
-- Grants: CREATE OR REPLACE keeps them (PUBLIC revoked in 0293; the
-- definers call it as their owner). The public demo's SELECT-only reader
-- (demo_reader, where it exists) runs the app's system pool, so it gets
-- EXECUTE on the three login facts the app now reads on every signed-in
-- request or area ask, as the runtime role has them (0304):
-- mantle_login_is_admin (the login row), mantle_login_areas (areasFor) and
-- mantle_area_rule (requireArea unscoped). The demo branch's
-- demo/deploy/readonly-role.sql needs the same three lines. No table, row
-- or trigger changes. Re-runnable: CREATE OR REPLACE and GRANT only.
--
-- The number is claimed at the merge (plan v3.2 rule 3): written as 0305
-- above main's 0304_login_facts (`when` 1790197560000) and above S2a a1+a2's
-- 0305_ws_user_definers (1790197620000), with `when` 1790197680000; the
-- branch renumbers on its rebase and keeps that `when` (the renumber proof
-- is in packages/db/src/admin-membership.db.test.ts).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_is_admin_user"(login uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "auth"."users" l
                  WHERE l."id" = login AND l."role" = 'admin' AND l."disabled_at" IS NULL)
     AND "public"."mantle_login_is_admin"(login)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_login_is_admin_user"(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_login_is_admin"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_login_areas"(uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_area_rule"(uuid, text) TO demo_reader;
  END IF;
END
$$;
