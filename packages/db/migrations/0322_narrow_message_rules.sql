-- The narrow role's message rows (assistant_messages), the full guard
-- (plan v3.2 S7b part b2 round 13b, item B: the re-audit's DB MED-B, app
-- L2 and L4, DB LOW-1). 0320's guard checked only an insert, let a row
-- with no assistant through, let a row name a workspace its assistant is
-- not in, and read a NULL workspace (the Admin workspace) as no rule at
-- all. The narrow role is the turn's hot path, so the INSERT stays; what
-- it may write is now one consistent shape:
--
-- 1. INSERT (and every way to one: ON CONFLICT's insert, MERGE's INSERT,
--    COPY FROM: each fires the BEFORE INSERT row trigger) must name this
--    brain, an assistant of this brain (never none), the workspace that
--    assistant is in (NULL only for an assistant of the Admin workspace),
--    and a login that may talk there: a user of the workspace, the owner,
--    or an Admin user; for the Admin workspace only the owner or an Admin
--    user. The direction is inbound or outbound.
-- 2. UPDATE (ON CONFLICT's update and MERGE's UPDATE too) of a row whose
--    status is not 'pending' may change nothing the narrow role holds a
--    right to (text, model, status, data, and error and attachments once
--    they are its) but the follow-up suggestion in data (suggestion,
--    suggestedAt: written after the turn is done). A pending row (the
--    durable "thinking" bubble) is the turn's own until it settles, and a
--    settled row never goes back to pending. A finished turn's text is
--    what later turns read as history, so it is never rewritten.
-- 3. Off the narrow route (the switch off) the same break by a narrow
--    reason (or on a statement marked mantle.route = 'narrow'), not at a
--    spot, is counted as one the narrow role would refuse (0319's report
--    notice), and runs.
--
-- The narrow role's EXECUTE of mantle_narrow_message_ok stays (runtime-
-- role.ts NARROW_SYSTEM_FUNCTIONS). Re-runnable. No table or row changes;
-- no LLM work. Revert: packages/db/rollback/0322_narrow_message_rules.revert.sql
-- (0320's guard back), before 0321's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_message_ok"(
  owner uuid, agent uuid, login uuid, ws uuid)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  -- A definer: it reads agents, workspaces, workspace_users and auth.users,
  -- which the narrow role may not read whole. NULL when the row is
  -- consistent, else why.
  WITH a AS (
    SELECT x."workspace_id" AS ws
      FROM "public"."agents" x
     WHERE x."id" = "mantle_narrow_message_ok"."agent"
       AND x."owner_id" = "mantle_narrow_message_ok"."owner"),
  admin_user AS (
    SELECT EXISTS (
             SELECT 1 FROM "auth"."users" l
              WHERE l."id" = "mantle_narrow_message_ok"."login" AND l."is_owner")
        OR EXISTS (
             SELECT 1 FROM "public"."workspace_users" u
               JOIN "public"."workspaces" w ON w."id" = u."workspace_id" AND w."is_admin"
              WHERE u."login_id" = "mantle_narrow_message_ok"."login") AS ok)
  SELECT CASE
    WHEN "mantle_narrow_message_ok"."owner" IS DISTINCT FROM "public"."mantle_brain_id"()
      THEN 'only this brain''s'
    WHEN "mantle_narrow_message_ok"."agent" IS NULL
      THEN 'a row names its assistant'
    WHEN NOT EXISTS (SELECT 1 FROM a)
      THEN 'only this brain''s assistant'
    WHEN "mantle_narrow_message_ok"."ws" IS DISTINCT FROM (SELECT a.ws FROM a)
      THEN 'the workspace is its assistant''s'
    WHEN "mantle_narrow_message_ok"."login" IS NULL
      THEN 'a row names its login'
    WHEN "mantle_narrow_message_ok"."ws" IS NULL AND NOT (SELECT ok FROM admin_user)
      THEN 'the Admin workspace: the owner or an Admin user only'
    WHEN "mantle_narrow_message_ok"."ws" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "public"."workspace_users" u
            WHERE u."workspace_id" = "mantle_narrow_message_ok"."ws"
              AND u."login_id" = "mantle_narrow_message_ok"."login")
         AND NOT (SELECT ok FROM admin_user)
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
  who text := coalesce("public"."mantle_identity_actor"(), '');
  own_role text := CASE WHEN current_setting('role') = 'none' THEN session_user::text
                        ELSE current_setting('role') END;
  report boolean := false;
  why text;
  o jsonb;
  n jsonb;
  -- What a settled row may still gain: the follow-up suggestion.
  late constant text[] := ARRAY['suggestion', 'suggestedAt'];
BEGIN
  -- As the caller: the narrow role's own writes are checked; a definer's
  -- (current_user its owner) are not.
  IF current_user <> 'mantle_system_narrow' THEN
    -- Report only (0319): the same row by a narrow reason off the narrow
    -- route, not at a spot, is counted and runs.
    IF "public"."mantle_narrow_counted"(who)
       AND current_user::text = own_role
       AND coalesce(current_setting('mantle.route', true), '') <> 'full' THEN
      report := true;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW."direction" IS NULL OR NEW."direction" NOT IN ('inbound', 'outbound') THEN
        RAISE EXCEPTION 'assistant_messages: the direction is inbound or outbound'
          USING ERRCODE = '42501';
      END IF;
      why := "public"."mantle_narrow_message_ok"(
        NEW."owner_id", NEW."agent_id", NEW."login_id", NEW."workspace_id");
      IF why IS NOT NULL THEN
        RAISE EXCEPTION 'assistant_messages: %', why USING ERRCODE = '42501';
      END IF;
    ELSIF OLD."status" IS DISTINCT FROM 'pending' THEN
      o := to_jsonb(OLD) - 'data';
      n := to_jsonb(NEW) - 'data';
      IF o IS DISTINCT FROM n
         OR (coalesce(OLD."data", '{}'::jsonb) - late)
            IS DISTINCT FROM (coalesce(NEW."data", '{}'::jsonb) - late) THEN
        RAISE EXCEPTION 'assistant_messages: a settled row is not rewritten (only a pending one)'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    IF NOT report THEN
      RAISE;
    END IF;
    RAISE NOTICE 'mantle narrow write: narrow-would-refuse % %.% %', who, TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP;
  END;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_message_guard"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_message_guard_trg" ON "public"."assistant_messages";
--> statement-breakpoint
-- After assistant_messages_stamp_ws (BEFORE triggers fire by name): the
-- guard reads the stamped workspace and login.
CREATE TRIGGER "mantle_narrow_message_guard_trg" BEFORE INSERT OR UPDATE ON "public"."assistant_messages"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_message_guard"();
