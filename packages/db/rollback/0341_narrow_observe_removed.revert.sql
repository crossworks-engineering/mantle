-- Rollback of 0341_narrow_observe_removed: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Optional: the older image runs with 0341 in place. Its migrate's trigger
-- step finds no count function and makes nothing, its box script reads the
-- counts as absent, and nothing it does is refused for 0341. What it lacks
-- is the report branch's counts (narrow-content-write, narrow-cascade-delete,
-- narrow-would-refuse), which only told a write made off the narrow route:
-- with the switch on, as on every box since S7b, there is none.
--
-- This puts back, as 0329 left them: the report predicate and what it read
-- (mantle_narrow_actor, mantle_narrow_counted, mantle_narrow_report), the
-- would-refuse function, its derivation and the box's missing-trigger count,
-- the cascade count with its three triggers, the content count's arm in
-- mantle_actor_check_stmt and the report arms of the one-way rules, the
-- message guard and the two holds. The derived would-refuse triggers are not
-- made here: the older image's migrate makes them from the grants on its
-- next run. Then it takes 0341 off the ledger, so the next roll forward
-- applies it again (it is re-runnable).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0341_narrow_observe_removed.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_actor(actor text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT actor = ANY (ARRAY[
    'system:admin-area',
    'system:agent-workspace',
    'system:audit-log',
    'system:connector-binding',
    'system:connector-call',
    'system:heartbeat-own-row',
    'system:login-telegram',
    'system:pending-approval',
    'system:http:admin-area',
    'system:http:login-self'
  ]::text[])
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_counted(who text)
 RETURNS boolean
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT (who LIKE 'system:%' AND "public"."mantle_narrow_actor"(who))
      OR coalesce(current_setting('mantle.route', true), '') = 'narrow'
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_report(who text, held text DEFAULT NULL::text, id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- The session's own role: the role it SET, else its login. A definer
  -- changes current_user, never this (a variable: plpgsql ends an IF's
  -- test at its first THEN, a CASE's included).
  own_role text := CASE WHEN current_setting('role') = 'none' THEN session_user::text
                        ELSE current_setting('role') END;
BEGIN
  IF coalesce(who, '') NOT LIKE 'system:%'
     AND coalesce(current_setting('mantle.route', true), '') <> 'narrow' THEN
    RETURN false;
  END IF;
  BEGIN
    IF NOT ("public"."mantle_narrow_counted"(coalesce(who, ''))
            AND current_user::text = own_role
            AND coalesce(current_setting('mantle.route', true), '') <> 'full') THEN
      RETURN false;
    END IF;
    IF held IS NULL THEN
      RETURN true;
    END IF;
    IF held = 'login' THEN
      RETURN coalesce("public"."mantle_narrow_login_held"(id), false);
    END IF;
    IF held = 'client' THEN
      RETURN coalesce("public"."mantle_narrow_client_held"(id), false);
    END IF;
    RAISE EXCEPTION 'mantle_narrow_report: unknown hold %', held USING ERRCODE = '22023';
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN false;
  END;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_would_refuse_stmt()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  who text := coalesce("public"."mantle_identity_actor"(), '');
  seen_key text := 'mantle.narrow_would_' || TG_TABLE_SCHEMA || '_' || TG_TABLE_NAME;
BEGIN
  IF "public"."mantle_narrow_report"(who)
     AND position(TG_OP IN coalesce(current_setting(seen_key, true), '')) = 0 THEN
    PERFORM set_config(seen_key, coalesce(current_setting(seen_key, true), '') || TG_OP || ' ', true);
    RAISE NOTICE 'mantle narrow write: narrow-would-refuse % %.% %', who, TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP;
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mantle_narrow_would_refuse_stmt() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_would_refuse_expected()
 RETURNS TABLE(rel oid, trigger_name text, cols smallint[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  -- The would-refuse count's derived triggers the narrow role's grants call
  -- for, one row each: on every table of the app's schemas the actor check
  -- does not cover (0312 counts the content tables), an INSERT trigger
  -- where the role may not insert, a DELETE one where it may not delete,
  -- an UPDATE OF one naming exactly the columns it may not update (`cols`,
  -- their numbers in order; empty for the other two). No rows with no
  -- narrow role.
  WITH t AS (
    SELECT c.oid,
           has_table_privilege(to_regrole('mantle_system_narrow'), c.oid, 'INSERT') IS FALSE AS ins,
           has_table_privilege(to_regrole('mantle_system_narrow'), c.oid, 'DELETE') IS FALSE AS del,
           array(SELECT a.attnum FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                    AND has_column_privilege(to_regrole('mantle_system_narrow'), c.oid, a.attnum, 'UPDATE') IS FALSE
                  ORDER BY a.attnum) AS cols
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND to_regrole('mantle_system_narrow') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_trigger g
                        WHERE g.tgrelid = c.oid AND g.tgname = 'mantle_actor_check' AND NOT g.tgisinternal)
  )
  SELECT t.oid, 'mantle_narrow_would_refuse_ins', '{}'::int2[] FROM t WHERE t.ins
  UNION ALL
  SELECT t.oid, 'mantle_narrow_would_refuse_del', '{}'::int2[] FROM t WHERE t.del
  UNION ALL
  SELECT t.oid, 'mantle_narrow_would_refuse_upd', t.cols FROM t WHERE cardinality(t.cols) > 0
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mantle_narrow_would_refuse_expected() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_counter_missing()
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  -- The derived triggers the grants call for
  -- (mantle_narrow_would_refuse_expected) less the ones there: a trigger
  -- of that name, enabled (origin or always), calling the count's function
  -- and, for the UPDATE OF one, naming exactly its columns. 0 when the
  -- counter is whole. NULL with no narrow role or before 0320.
  SELECT CASE WHEN to_regprocedure('public.mantle_narrow_would_refuse_stmt()') IS NULL
                OR to_regrole('mantle_system_narrow') IS NULL THEN NULL ELSE
    (SELECT count(*) FROM "public"."mantle_narrow_would_refuse_expected"() e
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger g
         WHERE g.tgrelid = e.rel AND g.tgname = e.trigger_name AND NOT g.tgisinternal
           AND g.tgenabled IN ('O', 'A')
           AND g.tgfoid = to_regprocedure('public.mantle_narrow_would_refuse_stmt()')
           AND (e.trigger_name <> 'mantle_narrow_would_refuse_upd'
                OR (SELECT array_agg(x ORDER BY x) FROM unnest(g.tgattr::int2[]) x) = e.cols)))
  END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mantle_narrow_counter_missing() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_cascade_stmt()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  who text := coalesce("public"."mantle_identity_actor"(), '');
BEGIN
  IF pg_trigger_depth() = 1 AND who <> '' THEN
    IF "public"."mantle_narrow_report"(who)
       AND EXISTS (SELECT 1 FROM gone) THEN
      RAISE NOTICE 'mantle narrow write: narrow-cascade-delete % % DELETE', who, TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mantle_narrow_cascade_stmt() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_actor_check_stmt()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  seen_key text := 'mantle.actor_missed_' || TG_TABLE_NAME;
  narrow_key text := 'mantle.narrow_missed_' || TG_TABLE_NAME;
  who text := coalesce("public"."mantle_identity_actor"(), '');
  mode text;
BEGIN
  IF who <> '' THEN
    IF who LIKE 'system:%' OR coalesce(current_setting('mantle.route', true), '') = 'narrow' THEN
      IF "public"."mantle_narrow_report"(who)
         AND coalesce(current_setting(narrow_key, true), '') <> TG_OP THEN
        PERFORM set_config(narrow_key, TG_OP, true);
        RAISE NOTICE 'mantle narrow write: narrow-content-write % % %', who, TG_TABLE_NAME, TG_OP;
      END IF;
    END IF;
    RETURN NULL;
  END IF;
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  mode := "public"."mantle_actor_check_mode"();
  IF mode = 'off' THEN RETURN NULL; END IF;
  IF mode = 'on' THEN
    RAISE EXCEPTION 'mantle actor check: % on % with no actor', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '42501', DETAIL = 'no_actor';
  END IF;
  IF coalesce(current_setting(seen_key, true), '') = TG_OP THEN RETURN NULL; END IF;
  PERFORM set_config(seen_key, TG_OP, true);
  RAISE NOTICE 'mantle actor miss: % on %', TG_OP, TG_TABLE_NAME;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_one_way()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  who text := coalesce("public"."mantle_identity_actor"(), '');
  report boolean := false;
  o jsonb;
  n jsonb;
  arg text;
  kind text;
  col text;
  i int;
BEGIN
  IF current_user <> 'mantle_system_narrow' THEN
    -- Report only (0320): the same row change by a narrow reason's actor
    -- (or on a statement marked mantle.route = 'narrow') off the narrow
    -- route (the switch off), not at a spot, is counted as one the narrow
    -- role would refuse, and runs.
    IF "public"."mantle_narrow_report"(who) THEN
      report := true;
    ELSIF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  o := to_jsonb(OLD);
  IF TG_OP IN ('UPDATE', 'INSERT') THEN
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
      IF TG_OP = 'INSERT' AND kind <> 'off' THEN
        CONTINUE;
      ELSIF kind = 'keepif' THEN
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
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mantle_narrow_one_way() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_message_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  who text := coalesce("public"."mantle_identity_actor"(), '');
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
    -- Report only (0320): the same row by a narrow reason off the narrow
    -- route, not at a spot, is counted and runs.
    IF "public"."mantle_narrow_report"(who) THEN
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
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mantle_narrow_message_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_login_hold()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  who text := coalesce("public"."mantle_identity_actor"(), '');
BEGIN
  IF OLD."disabled_at" IS NOT DISTINCT FROM NEW."disabled_at"
     AND OLD."session_epoch" IS NOT DISTINCT FROM NEW."session_epoch" THEN
    RETURN NEW;
  END IF;
  IF current_user = 'mantle_system_narrow' THEN
    IF "public"."mantle_narrow_login_held"(OLD."id") THEN
      RAISE EXCEPTION 'the narrow system role may not disable or sign out the owner or an Admin user'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- Report only (0320): the same change by a narrow reason's actor off the
  -- narrow route, not at a spot, is counted as one the role would refuse.
  -- The held test rides the one report predicate, so a role that may not
  -- run it (an older image's grants) writes, uncounted.
  IF "public"."mantle_narrow_report"(who, 'login', OLD."id") THEN
    RAISE NOTICE 'mantle narrow write: narrow-would-refuse % %.% UPDATE', who, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mantle_narrow_login_hold() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_narrow_token_hold()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  who text := coalesce("public"."mantle_identity_actor"(), '');
  o jsonb := to_jsonb(OLD);
  n jsonb;
  kind text := CASE WHEN TG_TABLE_NAME = 'oauth_clients' THEN 'client' ELSE 'login' END;
  id uuid := (CASE TG_TABLE_NAME
                WHEN 'oauth_clients' THEN o ->> 'id'
                WHEN 'access_keys' THEN o ->> 'login_id'
                WHEN 'mobile_tokens' THEN o ->> 'user_id'
                WHEN 'pairing_codes' THEN o ->> 'user_id'
                -- A device row with no login is the brain owner's (the
                -- devices from before logins were recorded).
                WHEN 'push_subscriptions' THEN coalesce(o ->> 'login_id', o ->> 'owner_id')
                WHEN 'mantle_peers' THEN o ->> 'acts_as_login_id'
                ELSE o ->> 'actor_id' END)::uuid;
BEGIN
  -- The 0327 hold, part 2 (2's sibling), widened in 0328: a revoke of the
  -- owner's or an Admin user's key, token or device, a delete of their
  -- open OAuth code, of an unclaimed pairing code or of a push device of
  -- theirs, a peer taken off acting as them, and a delete of an MCP client
  -- a live grant of theirs rides on, are held from the narrow role (the
  -- users area ends such a login's sessions at the spot login-credential).
  -- And on the narrow role a key's revoked_by is written only with its
  -- revoke, never rewritten on a key already revoked.
  IF TG_OP = 'UPDATE' THEN
    n := to_jsonb(NEW);
    IF TG_TABLE_NAME = 'mantle_peers' THEN
      IF (o -> 'acts_as_login_id') IS NOT DISTINCT FROM (n -> 'acts_as_login_id') THEN
        RETURN NEW;
      END IF;
    ELSE
      IF (o -> 'revoked_at') IS NOT DISTINCT FROM (n -> 'revoked_at')
         AND (o -> 'revoked_by') IS NOT DISTINCT FROM (n -> 'revoked_by') THEN
        RETURN NEW;
      END IF;
      IF current_user = 'mantle_system_narrow'
         AND (o -> 'revoked_by') IS DISTINCT FROM (n -> 'revoked_by')
         AND (o ->> 'revoked_at') IS NOT NULL THEN
        RAISE EXCEPTION 'the narrow system role may not rewrite %.revoked_by', TG_TABLE_NAME
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF current_user = 'mantle_system_narrow' THEN
    IF kind = 'client' THEN
      IF "public"."mantle_narrow_client_held"(id) THEN
        RAISE EXCEPTION 'the narrow system role may not revoke or remove a grant of the owner or an Admin user (%)', TG_TABLE_NAME
          USING ERRCODE = '42501';
      END IF;
    ELSIF "public"."mantle_narrow_login_held"(id) THEN
      RAISE EXCEPTION 'the narrow system role may not revoke or remove a grant of the owner or an Admin user (%)', TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;
  -- Report only (0320): the same write by a narrow reason's actor off the
  -- narrow route, not at a spot, is counted as one the role would refuse.
  -- The held test rides the one report predicate, so a role that may not
  -- run it (an older image's grants) writes, uncounted.
  ELSIF "public"."mantle_narrow_report"(who, kind, id) THEN
    RAISE NOTICE 'mantle narrow write: narrow-would-refuse % %.% %', who, TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mantle_narrow_token_hold() FROM PUBLIC;

--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_cascade" AFTER DELETE ON "auth"."users"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_narrow_cascade_stmt"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "public"."spaces";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_cascade" AFTER DELETE ON "public"."spaces"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_narrow_cascade_stmt"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "public"."agents";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_cascade" AFTER DELETE ON "public"."agents"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_narrow_cascade_stmt"();
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790200620000;
