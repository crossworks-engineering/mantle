-- Rollback of 0328_narrow_hold_wider: what an operator runs BEFORE pinning
-- an image older than the one that added it. Not a migration: nothing runs
-- it on its own.
--
-- It drops the grant hold's three new triggers (pairing_codes,
-- push_subscriptions, mantle_peers), puts 0327's hold body back and drops
-- mantle_narrow_counter_missing() and mantle_narrow_would_refuse_expected()
-- (the box script then reads its own copy of the query). Order when reverting several: 0329 first (its
-- revert file), then 0328, then 0327 down to 0315 (0327's revert file), each
-- in its own transaction, newest first.
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0328_narrow_hold_wider.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."pairing_codes";
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."push_subscriptions";
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."mantle_peers";
DROP FUNCTION IF EXISTS "public"."mantle_narrow_counter_missing"();
DROP FUNCTION IF EXISTS "public"."mantle_narrow_would_refuse_expected"();
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
                ELSE o ->> 'actor_id' END)::uuid;
BEGIN
  -- The 0327 hold, part 2 (2's sibling): a revoke of the owner's or an
  -- Admin user's key, token or device, a delete of their open OAuth code,
  -- and a delete of an MCP client a live grant of theirs rides on, are
  -- held from the narrow role (the users area ends such a login's
  -- sessions at the spot login-credential). And on the narrow role a
  -- key's revoked_by is written only with its revoke, never rewritten on
  -- a key already revoked.
  IF TG_OP = 'UPDATE' THEN
    n := to_jsonb(NEW);
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
REVOKE ALL ON FUNCTION "public"."mantle_narrow_token_hold"() FROM PUBLIC;
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790199760000;
