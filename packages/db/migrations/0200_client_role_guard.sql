-- A login's role never changes to or from client (client logins audit I8;
-- decision 11: a client login is made as one and stays one). Until now only
-- PATCH /api/users/:id refused it; this puts the rule in the database, so no
-- other path (a later route, a script, a bug) can turn a client into staff,
-- with staff's reads, or staff into a client. A client login gets its role
-- on INSERT (POST /api/team-admin/clients) and nothing updates it after: the
-- trigger fires on UPDATE only, and only when the role goes to or from
-- 'client'. admin and member still change into each other as before.
--
-- To end a client, Disable or delete it. An operator who truly must change
-- one disables the trigger in a transaction around that one UPDATE (the DB
-- tests do, test-support.ts `setLoginRoleUnguarded`).
--
-- Re-runnable. Rollback: the previous release never changes a client's
-- role either, so the trigger can stay.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_client_role_guard"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'a login''s role never changes to or from client (% to %)', OLD.role, NEW.role
    USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_client_role_guard"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_client_role_guard" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "users_client_role_guard"
  BEFORE UPDATE OF "role" ON "auth"."users"
  FOR EACH ROW
  WHEN (OLD."role" IS DISTINCT FROM NEW."role" AND (OLD."role" = 'client' OR NEW."role" = 'client'))
  EXECUTE FUNCTION "public"."mantle_client_role_guard"();
