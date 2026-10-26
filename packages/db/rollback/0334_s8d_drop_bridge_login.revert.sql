-- Rollback of 0334_s8d_drop_bridge_login: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional for that image: it calls no mantle_bridge_login (0330's image
-- already did not). It puts back 0330's demote-only body, its owner (the
-- membership definers' owner) and its rights (PUBLIC revoked; EXECUTE for
-- mantle_runtime and mantle_owner, as ensureRuntimeRoles grants it on the
-- older image's migrate), and takes 0334 off the ledger so the next roll
-- forward runs it again. Going below 0330 as well needs this one first:
-- 0330's revert reads this function's owner.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0334_s8d_drop_bridge_login.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_login"(login uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  admin_ws uuid;
  r text;
  gone int;
BEGIN
  -- Demote only since S8b: the membership definers add (0286's lookup and
  -- its removal half; its add half is gone).
  -- The anchor stays in Admin, as the Admin removal definer keeps it
  -- (0272's CHECK makes its role admin anyway; this does not lean on that).
  IF login IS NOT DISTINCT FROM "public"."mantle_brain_id"() THEN RETURN; END IF;
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin';
  IF admin_ws IS NULL THEN RETURN; END IF;
  -- The login's own role decides, nothing else: 0286 read a former client
  -- (archive_client_logins) as no role, which a row there could use to take
  -- an Admin user out of Admin. Former clients are members since 0272, so
  -- their role says the same without it.
  SELECT u."role" INTO r FROM auth.users u WHERE u."id" = login;
  -- A login that is not role admin is not a user of Admin.
  DELETE FROM "public"."workspace_users" u
   WHERE u."login_id" = login AND u."workspace_id" = admin_ws AND coalesce(r, '') <> 'admin';
  GET DIAGNOSTICS gone = ROW_COUNT;
  IF gone > 0 THEN
    INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
    VALUES (admin_ws, NULL, 'bridge.login', jsonb_build_object('login', login, 'role', r));
  END IF;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_login"(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  who name := (SELECT pg_catalog.pg_get_userbyid(p."proowner") FROM pg_catalog.pg_proc p
                WHERE p."oid" = '"public"."mantle_ws_add_user"(uuid, uuid, uuid, boolean)'::regprocedure);
BEGIN
  EXECUTE format('ALTER FUNCTION "public"."mantle_bridge_login"(uuid) OWNER TO %I', who);
  IF to_regrole('mantle_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_bridge_login"(uuid) TO mantle_runtime;
  END IF;
  IF to_regrole('mantle_owner') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_bridge_login"(uuid) TO mantle_owner;
  END IF;
END
$$;
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0334 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200200000;
