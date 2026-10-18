-- The Admin login is role AND membership (workspaces arch plan v3.2, S8a):
-- the SQL role read mantle_login_is_admin_user (0293) asks the same pair
-- the session guard asks since S8a (session.ts adminLogin: role admin AND
-- mantle_login_is_admin, read with the login row in loadLoginRow).
--
-- mantle_login_is_admin_user(login): its 0293 text, moved verbatim (role
-- 'admin', not disabled), AND mantle_login_is_admin(login) (0304: a user
-- of the brain's live Admin workspace, the login enabled). It only ANDs a
-- second condition, so it narrows: a role=admin login outside Admin is no
-- Admin user here either. Its readers, mantle_access_keys_seen (a login
-- NULL ask: every key, an Admin user's view) and mantle_access_key_revoke
-- (an Admin user may revoke any key), answer that login as they answer a
-- member. On a box with no role drift (mantle_role_drift() = 0, the S8a
-- precondition) no answer changes.
--
-- Grants: CREATE OR REPLACE keeps them (PUBLIC revoked in 0293; the
-- definers call it as their owner). No table, row or trigger changes.
-- Re-runnable: CREATE OR REPLACE only.
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
