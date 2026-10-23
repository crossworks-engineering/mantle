-- Rollback of 0321_narrow_row_rules: what an operator runs BEFORE pinning
-- an image older than the one that added it, if they want its rules gone.
-- Not a migration: nothing runs it on its own.
--
-- 0321 refuses only the narrow system role (and, for mantle_ws_system_work,
-- a session whose own role is the narrow or a viewer role), which an older
-- image's product writes never meet in a refused direction: a rollback of
-- one image needs NOT this file. Order when reverting several: every newer
-- one first (0327 down to 0322), then 0321, then 0320 down to 0315, each in
-- its own transaction, newest first (0320's revert puts 0319's
-- mantle_narrow_one_way back, so 0321's must run before it).
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0321_narrow_row_rules.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."heartbeats";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_keep_trg" ON "auth"."users";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."tool_groups";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."channels";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."telegram_accounts";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_message_guard_trg" ON "public"."assistant_messages";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_message_guard"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_message_ok"(uuid, uuid, uuid, uuid);
--> statement-breakpoint
-- 0320's body (no DELETE rules, no fwd, fwdn, nofrom, off or keepif).
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_one_way"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  who text := coalesce(current_setting('mantle.actor', true), '');
  report boolean := false;
  own_role text := CASE WHEN current_setting('role') = 'none' THEN session_user::text
                        ELSE current_setting('role') END;
  o jsonb;
  n jsonb;
  arg text;
  col text;
  i int;
BEGIN
  IF current_user <> 'mantle_system_narrow' THEN
    -- Report only (0320): the same row change by a narrow reason's actor
    -- (or on a statement marked mantle.route = 'narrow')
    -- off the narrow route (the switch off), not at a spot, is counted as
    -- one the narrow role would refuse, and runs.
    IF "public"."mantle_narrow_counted"(who)
       AND current_user::text = own_role
       AND coalesce(current_setting('mantle.route', true), '') <> 'full' THEN
      report := true;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  BEGIN
    FOR i IN 0 .. TG_NARGS - 1 LOOP
      arg := TG_ARGV[i];
      col := split_part(arg, ':', 2);
      IF split_part(arg, ':', 1) = 'clear' THEN
        IF (o ->> col) IS NOT NULL AND (n ->> col) IS NULL THEN
          RAISE EXCEPTION 'the narrow system role may not clear %.%', TG_TABLE_NAME, col
            USING ERRCODE = '42501';
        END IF;
      ELSIF split_part(arg, ':', 1) = 'up' THEN
        IF (n ->> col)::numeric < (o ->> col)::numeric THEN
          RAISE EXCEPTION 'the narrow system role may not lower %.%', TG_TABLE_NAME, col
            USING ERRCODE = '42501';
        END IF;
      ELSIF split_part(arg, ':', 1) = 'drop' THEN
        IF (o -> col) IS DISTINCT FROM (n -> col) AND (n ->> col) IS NOT NULL THEN
          RAISE EXCEPTION 'the narrow system role may only clear %.%', TG_TABLE_NAME, col
            USING ERRCODE = '42501';
        END IF;
      ELSIF split_part(arg, ':', 1) = 'from' THEN
        IF (o -> col) IS DISTINCT FROM (n -> col)
           AND (n -> col) IS DISTINCT FROM (o -> split_part(arg, ':', 3)) THEN
          RAISE EXCEPTION 'the narrow system role may set %.% only from %', TG_TABLE_NAME, col,
            split_part(arg, ':', 3) USING ERRCODE = '42501';
        END IF;
      ELSIF split_part(arg, ':', 1) = 'keep' THEN
        IF (o -> col -> split_part(arg, ':', 3)) IS DISTINCT FROM (n -> col -> split_part(arg, ':', 3)) THEN
          RAISE EXCEPTION 'the narrow system role may not change %.% %', TG_TABLE_NAME, col,
            split_part(arg, ':', 3) USING ERRCODE = '42501';
        END IF;
      ELSE
        RAISE EXCEPTION 'mantle_narrow_one_way: unknown rule %', arg USING ERRCODE = '22023';
      END IF;
    END LOOP;
  EXCEPTION WHEN insufficient_privilege THEN
    IF NOT report THEN
      RAISE;
    END IF;
    RAISE NOTICE 'mantle narrow write: narrow-would-refuse % %.% UPDATE', who, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_one_way"() FROM PUBLIC;
--> statement-breakpoint
-- The agents trigger as 0319 made it.
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."agents";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."agents"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('drop:assigned_user_id', 'keep:memory_config:delegate_to');
--> statement-breakpoint
-- 0313's body.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_system_work"(fn text)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_scope_login_id"() IS NULL
     AND NOT "public"."mantle_scope_active"()
     AND coalesce(current_setting('mantle.write_mode', true), '') <> 'ro'
     AND (coalesce(current_setting('mantle.actor', true), ''), fn) IN (
           ('system:ws-clear-ticks', 'mantle_ws_set_moderator'),
           ('system:boot:migrate-workspaces', 'mantle_ws_attach_assistants'),
           ('system:snapshot-copies', 'mantle_file_restamp_home'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_system_work"(text) FROM PUBLIC;
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0321 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790199340000;
