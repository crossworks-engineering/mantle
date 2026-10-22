-- Rollback of 0322_narrow_message_rules: what an operator runs BEFORE
-- pinning an image older than the one that added it, if they want its
-- rules gone. Not a migration: nothing runs it on its own.
--
-- 0322 refuses only the narrow system role (and counts the same break by a
-- narrow reason off the narrow route), which an older image's product
-- writes never meet in a refused direction: a rollback of one image needs
-- NOT this file. Order when reverting several: 0322 first, then 0321, then
-- 0320, then 0319 down to 0314, each in its own transaction, newest first
-- (0320's revert drops the guard this file puts back).
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0322_narrow_message_rules.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- 0320's guard: an insert only, its four checks.
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_message_ok"(
  owner uuid, agent uuid, login uuid, ws uuid)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  -- A definer: it reads workspace_users and auth.users, which the narrow
  -- role may not read whole. NULL when the row is consistent, else why.
  SELECT CASE
    WHEN "mantle_narrow_message_ok"."owner" IS DISTINCT FROM "public"."mantle_brain_id"()
      THEN 'only this brain''s'
    WHEN "mantle_narrow_message_ok"."agent" IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM "public"."agents" a
            WHERE a."id" = "mantle_narrow_message_ok"."agent"
              AND a."owner_id" = "mantle_narrow_message_ok"."owner")
      THEN 'only this brain''s assistant'
    WHEN "mantle_narrow_message_ok"."login" IS NOT NULL AND "mantle_narrow_message_ok"."ws" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "public"."workspace_users" u
            WHERE u."workspace_id" = "mantle_narrow_message_ok"."ws"
              AND u."login_id" = "mantle_narrow_message_ok"."login")
         AND NOT EXISTS (
           SELECT 1 FROM "auth"."users" l
            WHERE l."id" = "mantle_narrow_message_ok"."login" AND l."is_owner")
         AND NOT EXISTS (
           SELECT 1 FROM "public"."workspace_users" x
             JOIN "public"."workspaces" w ON w."id" = x."workspace_id" AND w."is_admin"
            WHERE x."login_id" = "mantle_narrow_message_ok"."login")
      THEN 'the login is not a user of the workspace'
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_message_ok"(uuid, uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_message_guard"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  why text;
BEGIN
  -- As the caller: only the narrow role's own inserts are checked.
  IF current_user <> 'mantle_system_narrow' THEN
    RETURN NEW;
  END IF;
  IF NEW."direction" IS NULL OR NEW."direction" NOT IN ('inbound', 'outbound') THEN
    RAISE EXCEPTION 'assistant_messages: the direction is inbound or outbound' USING ERRCODE = '42501';
  END IF;
  why := "public"."mantle_narrow_message_ok"(NEW."owner_id", NEW."agent_id", NEW."login_id", NEW."workspace_id");
  IF why IS NOT NULL THEN
    RAISE EXCEPTION 'assistant_messages: %', why USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_message_guard"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_message_guard_trg" ON "public"."assistant_messages";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_message_guard_trg" BEFORE INSERT ON "public"."assistant_messages"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_message_guard"();
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0322 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198640000;
