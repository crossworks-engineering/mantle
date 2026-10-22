-- The narrow login's rules a column right cannot hold,
-- proven open as the real narrow login (session_user mantle_system_narrow)
-- by the full re-audit of the database side.
--
-- 1. mantle_narrow_one_way (0318, 0319's report branch kept) takes more
--    rules and also runs BEFORE DELETE. New rules:
--      'fwd:<col>'        a timestamp once set is never cleared nor moved
--                         earlier;
--      'fwdn:<col>'       a timestamp may go to NULL, never earlier, and
--                         never from NULL to a value (a re-arm);
--      'nofrom:<col>:<a|b>:<to>'  never from one of the listed values to
--                         <to>;
--      'off:<col>'        a boolean is only ever switched off (false to
--                         true refused);
--      'keepif:<col>:<v>' (DELETE) a row whose <col> reads <v> is never
--                         deleted.
--    A refused write raises 42501 and changes nothing; off the narrow
--    route the same break by a narrow reason is counted (0319).
-- 2. heartbeats: fire_count only up, last_fired_at only forward,
--    next_fire_at only forward or to NULL (never re-armed), and status
--    never from completed, cancelled or paused back to active: the
--    narrow login may keep a fire's books, never fire a heartbeat again
--    or sooner (a fire runs a model: cost safety). A resume, a snooze and
--    a state change run at the full-route spot heartbeat-maker.
-- 3. auth.users: the narrow role holds no DELETE (access-matrix.ts
--    NARROW_WRITES; a login's delete runs at login-credential), and this
--    rule refuses it the brain owner's row and an Admin user's row whatever
--    its grants say: the owner's delete cascades the whole brain.
-- 4. enabled only off on tool_groups, agents, channels and
--    telegram_accounts: an enable (a group's tools, an assistant, a bot
--    answering again) runs at the full-route spot that grants it.
-- 5. assistant_messages: a row the narrow role inserts must be this
--    brain's, its login a user of its workspace (or of the Admin
--    workspace, or the owner), its
--    assistant this brain's, its direction inbound or outbound. A cheap
--    consistency guard; the narrow INSERT stays (the turn's hot path) and
--    the real fix is the signed acting login (the next step).
-- 6. mantle_ws_system_work (0313) trusted a setting the session sets
--    itself (mantle.actor): the narrow login, and a session under the
--    write role, made a member a Moderator through mantle_ws_set_moderator.
--    It now also needs a system session whose own role (the role it SET,
--    else its login) is the system role, the runtime role, the owner role,
--    a superuser or the definers' owner: never the narrow role, a viewer
--    role or the write role.
--
-- Re-runnable. No table or row changes; no LLM work. Revert:
-- packages/db/rollback/0320_narrow_row_rules.revert.sql. The `when` sits
-- 60 above 0319's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
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
  kind text;
  col text;
  i int;
BEGIN
  IF current_user <> 'mantle_system_narrow' THEN
    -- Report only (0319): the same row change by a narrow reason's actor
    -- (or on a statement marked mantle.route = 'narrow') off the narrow
    -- route (the switch off), not at a spot, is counted as one the narrow
    -- role would refuse, and runs.
    IF "public"."mantle_narrow_counted"(who)
       AND current_user::text = own_role
       AND coalesce(current_setting('mantle.route', true), '') <> 'full' THEN
      report := true;
    ELSIF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  o := to_jsonb(OLD);
  IF TG_OP = 'UPDATE' THEN
    n := to_jsonb(NEW);
  END IF;
  BEGIN
    FOR i IN 0 .. TG_NARGS - 1 LOOP
      arg := TG_ARGV[i];
      kind := split_part(arg, ':', 1);
      col := split_part(arg, ':', 2);
      IF TG_OP = 'DELETE' THEN
        IF kind = 'keepif' THEN
          IF (o ->> col) = split_part(arg, ':', 3) THEN
            RAISE EXCEPTION 'the narrow system role may not delete this %', TG_TABLE_NAME
              USING ERRCODE = '42501';
          END IF;
        END IF;
        CONTINUE;
      END IF;
      IF kind = 'keepif' THEN
        CONTINUE;
      ELSIF kind = 'clear' THEN
        IF (o ->> col) IS NOT NULL AND (n ->> col) IS NULL THEN
          RAISE EXCEPTION 'the narrow system role may not clear %.%', TG_TABLE_NAME, col
            USING ERRCODE = '42501';
        END IF;
      ELSIF kind = 'up' THEN
        IF (n ->> col)::numeric < (o ->> col)::numeric
           OR ((o ->> col) IS NOT NULL AND (n ->> col) IS NULL) THEN
          RAISE EXCEPTION 'the narrow system role may not lower %.%', TG_TABLE_NAME, col
            USING ERRCODE = '42501';
        END IF;
      ELSIF kind = 'fwd' THEN
        IF (o ->> col) IS NOT NULL
           AND ((n ->> col) IS NULL OR (n ->> col)::timestamptz < (o ->> col)::timestamptz) THEN
          RAISE EXCEPTION 'the narrow system role may not move %.% back', TG_TABLE_NAME, col
            USING ERRCODE = '42501';
        END IF;
      ELSIF kind = 'fwdn' THEN
        IF (n ->> col) IS NOT NULL
           AND ((o ->> col) IS NULL OR (n ->> col)::timestamptz < (o ->> col)::timestamptz) THEN
          RAISE EXCEPTION 'the narrow system role may not move %.% earlier or set it again', TG_TABLE_NAME, col
            USING ERRCODE = '42501';
        END IF;
      ELSIF kind = 'nofrom' THEN
        IF (o ->> col) = ANY (string_to_array(split_part(arg, ':', 3), '|'))
           AND (n ->> col) = split_part(arg, ':', 4) THEN
          RAISE EXCEPTION 'the narrow system role may not set %.% back to %', TG_TABLE_NAME, col,
            split_part(arg, ':', 4) USING ERRCODE = '42501';
        END IF;
      ELSIF kind = 'off' THEN
        IF coalesce((o ->> col)::boolean, false) = false AND coalesce((n ->> col)::boolean, false) THEN
          RAISE EXCEPTION 'the narrow system role may only switch %.% off', TG_TABLE_NAME, col
            USING ERRCODE = '42501';
        END IF;
      ELSIF kind = 'drop' THEN
        IF (o -> col) IS DISTINCT FROM (n -> col) AND (n ->> col) IS NOT NULL THEN
          RAISE EXCEPTION 'the narrow system role may only clear %.%', TG_TABLE_NAME, col
            USING ERRCODE = '42501';
        END IF;
      ELSIF kind = 'from' THEN
        IF (o -> col) IS DISTINCT FROM (n -> col)
           AND (n -> col) IS DISTINCT FROM (o -> split_part(arg, ':', 3)) THEN
          RAISE EXCEPTION 'the narrow system role may set %.% only from %', TG_TABLE_NAME, col,
            split_part(arg, ':', 3) USING ERRCODE = '42501';
        END IF;
      ELSIF kind = 'keep' THEN
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
    RAISE NOTICE 'mantle narrow write: narrow-would-refuse % %.% %', who, TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP;
  END;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_one_way"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."heartbeats";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."heartbeats"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"(
    'up:fire_count', 'fwd:last_fired_at', 'fwdn:next_fire_at',
    'nofrom:status:completed|cancelled|paused:active');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_keep_trg" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_keep_trg" BEFORE DELETE ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('keepif:is_owner:true', 'keepif:role:admin');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."agents";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."agents"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"(
    'drop:assigned_user_id', 'keep:memory_config:delegate_to', 'off:enabled');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."tool_groups";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."tool_groups"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('off:enabled');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."channels";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."channels"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('off:enabled');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."telegram_accounts";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."telegram_accounts"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('off:enabled');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_message_guard"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  -- A definer (to read workspace_users and auth.users, which the narrow
  -- role may not read whole); it checks only the narrow role's rows.
  IF session_user <> 'mantle_system_narrow'
     AND coalesce(current_setting('role'), 'none') <> 'mantle_system_narrow' THEN
    RETURN NEW;
  END IF;
  IF NEW."direction" IS NULL OR NEW."direction" NOT IN ('inbound', 'outbound') THEN
    RAISE EXCEPTION 'assistant_messages: the direction is inbound or outbound' USING ERRCODE = '42501';
  END IF;
  IF NEW."owner_id" IS DISTINCT FROM "public"."mantle_brain_id"() THEN
    RAISE EXCEPTION 'assistant_messages: only this brain''s' USING ERRCODE = '42501';
  END IF;
  IF NEW."agent_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "public"."agents" a
        WHERE a."id" = NEW."agent_id" AND a."owner_id" = NEW."owner_id") THEN
    RAISE EXCEPTION 'assistant_messages: only this brain''s assistant' USING ERRCODE = '42501';
  END IF;
  IF NEW."login_id" IS NOT NULL AND NEW."workspace_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "public"."workspace_users" u
        WHERE u."workspace_id" = NEW."workspace_id" AND u."login_id" = NEW."login_id")
     AND NOT EXISTS (
       SELECT 1 FROM "auth"."users" l
        WHERE l."id" = NEW."login_id" AND l."is_owner")
     AND NOT EXISTS (
       SELECT 1 FROM "public"."workspace_users" a
         JOIN "public"."workspaces" w ON w."id" = a."workspace_id" AND w."is_admin"
        WHERE a."login_id" = NEW."login_id") THEN
    RAISE EXCEPTION 'assistant_messages: the login is not a user of the workspace' USING ERRCODE = '42501';
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
CREATE OR REPLACE FUNCTION "public"."mantle_ws_system_work"(fn text)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_scope_login_id"() IS NULL
     AND NOT "public"."mantle_scope_active"()
     AND coalesce(current_setting('mantle.write_mode', true), '') <> 'ro'
     AND "public"."mantle_system_session"()
     AND session_user <> 'mantle_system_narrow'
     AND (CASE WHEN current_setting('role') = 'none' THEN session_user::text
               ELSE current_setting('role') END) IN (
           SELECT x FROM unnest(ARRAY['mantle_system', 'mantle_runtime', 'mantle_owner',
                                      current_user::text]) x
           UNION ALL
           SELECT r.rolname::text FROM pg_catalog.pg_roles r WHERE r.rolsuper)
     AND (CASE WHEN current_setting('role') = 'none' THEN session_user::text
               ELSE current_setting('role') END) <> 'mantle_system_narrow'
     AND (coalesce(current_setting('mantle.actor', true), ''), fn) IN (
           ('system:ws-clear-ticks', 'mantle_ws_set_moderator'),
           ('system:boot:migrate-workspaces', 'mantle_ws_attach_assistants'),
           ('system:snapshot-copies', 'mantle_file_restamp_home'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_system_work"(text) FROM PUBLIC;
