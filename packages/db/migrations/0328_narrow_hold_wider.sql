-- The b3 checklist (plan v3.2 S7b part b3), in the database:
--
-- 1. The grant hold (0327's mantle_narrow_token_hold) widened to three more
--    ways a held login (the owner, a login whose role is admin, a user of
--    the Admin workspace: mantle_narrow_login_held) loses a way in or a
--    channel to it, each refused to the narrow role and counted off the
--    narrow route by a narrow reason (0320's one report predicate):
--    - pairing_codes DELETE: the users area's lockout removes a login's
--      unclaimed codes (a code signs a phone in as its login);
--    - push_subscriptions DELETE: a device unpaired, signed out or reset
--      (a row with no login is the brain owner's);
--    - mantle_peers.acts_as_login_id to NULL: a peer taken off acting as
--      the login (0319 already holds it one way, to NULL only).
--    The product sites run at the full-route spot login-credential for a
--    held login (onLoginHoldSpot), as 0327's.
-- 2. mantle_narrow_would_refuse_expected(): the derived would-refuse
--    triggers the narrow role's grants call for, one row each, the one
--    derivation (migrate makes the triggers from it, runtime-role.ts
--    applyNarrowWouldRefuse); and mantle_narrow_counter_missing(): those
--    less the ones there, enabled and calling the count's function (0 when
--    the count is whole). The box script (scripts/arch-scoreboard-box.sh)
--    and the would-refuse cell read it. No EXECUTE for PUBLIC: the owner
--    role (the login migrate runs as) and a superuser run them.
--
-- Revert: packages/db/rollback/0328_narrow_hold_wider.revert.sql (0328
-- first, before 0327).
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_token_hold"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
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
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_token_hold"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."pairing_codes";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_token_hold_trg" BEFORE DELETE ON "public"."pairing_codes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_token_hold"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."push_subscriptions";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_token_hold_trg" BEFORE DELETE ON "public"."push_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_token_hold"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."mantle_peers";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_token_hold_trg" BEFORE UPDATE OF "acts_as_login_id" ON "public"."mantle_peers"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_token_hold"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_would_refuse_expected"()
  RETURNS TABLE ("rel" oid, "trigger_name" text, "cols" int2[]) LANGUAGE sql STABLE
  SET search_path = "pg_catalog", pg_temp AS $$
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
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_would_refuse_expected"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_counter_missing"()
  RETURNS bigint LANGUAGE sql STABLE
  SET search_path = "pg_catalog", pg_temp AS $$
  -- The derived triggers the grants call for
  -- (mantle_narrow_would_refuse_expected) less the ones there: a trigger
  -- of that name, not disabled, calling the count's function and, for the
  -- UPDATE OF one, naming exactly its columns. 0 when the counter is
  -- whole. NULL with no narrow role or before 0320.
  SELECT CASE WHEN to_regprocedure('public.mantle_narrow_would_refuse_stmt()') IS NULL
                OR to_regrole('mantle_system_narrow') IS NULL THEN NULL ELSE
    (SELECT count(*) FROM "public"."mantle_narrow_would_refuse_expected"() e
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger g
         WHERE g.tgrelid = e.rel AND g.tgname = e.trigger_name AND NOT g.tgisinternal
           AND g.tgenabled <> 'D'
           AND g.tgfoid = to_regprocedure('public.mantle_narrow_would_refuse_stmt()')
           AND (e.trigger_name <> 'mantle_narrow_would_refuse_upd'
                OR (SELECT array_agg(x ORDER BY x) FROM unnest(g.tgattr::int2[]) x) = e.cols)))
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_counter_missing"() FROM PUBLIC;
