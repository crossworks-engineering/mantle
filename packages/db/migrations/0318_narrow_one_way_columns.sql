-- The narrow system role's column rights (plan v3.2 S7b part b2) name the
-- columns narrow work writes, but a column right cannot tell a narrowing
-- write from a widening one: the role that may set a key's revoked_at may
-- also set it back to NULL, which brings a revoked key, token, device,
-- invite or peer share back to life, and the role that may bump a login's
-- session_epoch may also lower it, which brings ended sessions back. On the
-- narrow login the acting login is only a mistake guard, so these columns
-- must hold the direction themselves.
--
-- mantle_narrow_one_way(): a BEFORE UPDATE trigger, as the caller (no
-- SECURITY DEFINER), that does nothing unless current_user is the narrow
-- role (the narrow login, or the role SET per transaction in per-database
-- mode; a definer's own frame is its owner and is not checked here). Each
-- trigger argument names a column and its rule:
--   'clear:<col>'       a value once set is never cleared (NULL again);
--   'up:<col>'          a number is never lowered;
--   'drop:<col>'        the column changes only to NULL (an unbind);
--   'from:<col>:<src>'  the column changes only to the row's old <src>
--                       (a session end remembering whom a peer acted as).
-- A refused write raises 42501 and changes nothing. Every product write of
-- these columns on a narrow exit sets a revoke to now() where it is NULL or
-- bumps the epoch by one (measured: the switch-on suites), so no answer
-- changes; a login's enable (disabled_at back to NULL) runs at the
-- full-route spot login-credential.
--
-- The narrow role owns no table and may not drop, disable or replace a
-- trigger, nor set session_replication_role (superuser only).
--
-- Re-runnable. No table or row changes; no LLM work. Revert:
-- packages/db/rollback/0318_narrow_one_way_columns.revert.sql. The `when`
-- sits 60000 above 0317's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_one_way"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  o jsonb;
  n jsonb;
  arg text;
  col text;
  i int;
BEGIN
  IF current_user <> 'mantle_system_narrow' THEN
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
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
    ELSE
      RAISE EXCEPTION 'mantle_narrow_one_way: unknown rule %', arg USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_one_way"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('clear:disabled_at', 'up:session_epoch');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."access_keys";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."access_keys"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('clear:revoked_at');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."oauth_access_tokens";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."oauth_access_tokens"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('clear:revoked_at');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."mobile_tokens";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."mobile_tokens"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('clear:revoked_at');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."member_invites";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."member_invites"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('clear:revoked_at');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."peer_shares";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."peer_shares"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('clear:revoked_at');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."peer_share_scopes";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."peer_share_scopes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('clear:revoked_at');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."mantle_peers";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE UPDATE ON "public"."mantle_peers"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('drop:acts_as_login_id', 'from:ended_acts_as_login_id:acts_as_login_id');
