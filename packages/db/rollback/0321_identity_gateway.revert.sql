-- Rollback of 0321_identity_gateway: what an operator runs BEFORE pinning
-- an image older than the one that added it, if they want the identity
-- gateway gone. Not a migration: nothing runs it on its own.
--
-- 0321 changes what the readers answer only on the narrow system role, and
-- requires the acting login where a definer read it; an older image's
-- product writes reach those definers on the full route with the acting
-- login sent, so a rollback of one image needs NOT this file. Order when
-- reverting several: 0321 first, then 0320, then 0319 down to 0314, each in
-- its own transaction, newest first (0320's revert puts 0319's
-- mantle_narrow_one_way back, whose body this file must have restored the
-- reads of first).
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0321_identity_gateway.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- The direct reads back, the bodies otherwise unchanged.
DO $do$
DECLARE
  f record;
  def text;
BEGIN
  FOR f IN
    SELECT p.oid, p.proname::text AS name
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.prosrc LIKE '%"public"."mantle_identity_acting_login_required"()%'
            OR p.prosrc LIKE '%"public"."mantle_identity_actor"()%')
       AND p.proname NOT LIKE 'mantle\_identity\_%'
  LOOP
    def := pg_catalog.pg_get_functiondef(f.oid);
    def := replace(def, '"public"."mantle_identity_acting_login_required"()',
                   'nullif(current_setting(''mantle.acting_login'', true), '''')::uuid');
    def := replace(def, 'coalesce("public"."mantle_identity_actor"(), '''')',
                   'coalesce(current_setting(''mantle.actor'', true), '''')');
    IF def LIKE '%mantle_identity_%' THEN
      RAISE EXCEPTION '0321 revert: % still names a reader', f.name;
    END IF;
    EXECUTE def;
  END LOOP;
END
$do$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_id"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('mantle.login_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_login_id"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce("public"."mantle_login_id"(),
                  nullif(current_setting('mantle.scope_login', true), '')::uuid)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_ws"()
  RETURNS uuid[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(nullif(current_setting('mantle.ws', true), '')::uuid[], '{}'::uuid[])
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_mod_ws"()
  RETURNS uuid[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(nullif(current_setting('mantle.mod_ws', true), '')::uuid[], '{}'::uuid[])
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_active"()
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('mantle.ws', true), '') <> ''
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_setting_uuid"(name text)
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN coalesce(current_setting(name, true), '')
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN current_setting(name, true)::uuid END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_identity_leaks"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_identity_acting_login_required"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_identity_acting_login"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_identity_actor"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_identity_narrow"();
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0321 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198580000;
