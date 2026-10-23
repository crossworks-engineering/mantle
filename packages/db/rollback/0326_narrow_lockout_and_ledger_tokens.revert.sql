-- Rollback of 0326_narrow_lockout_and_ledger_tokens: what an operator runs
-- BEFORE pinning an image older than the one that added it. Not a
-- migration: nothing runs it on its own.
--
-- It puts the derivation flag back as it was (the nine functions that set
-- it and the two item_grants triggers read it bare again; the signing
-- helpers and their catalog check go), drops the settle definer, the login
-- hold and the miss guard (with their triggers), puts back 0325's claim
-- (the token budget from the member chat traces) and drops the ledger's
-- tokens column. 0321's non-identity key list keeps 'mantle.acl_sig' (a
-- key nothing sets then). An image of 0325 calls the claim with the same
-- arguments; an older image writes the ledger itself and never reads the
-- column. Order when reverting several:
-- 0326 first, then 0325, 0324, 0323, 0322, 0321, 0320, then 0319 down to
-- 0314, each in its own transaction, newest first.
--
-- Run it as the superuser, in one transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0326_narrow_lockout_and_ledger_tokens.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- 4 first: the eleven bodies back to the bare flag (as 0241 to 0272 made
-- them), then the helpers and the check go.
DROP FUNCTION IF EXISTS "public"."mantle_acl_flag_leaks"();
--> statement-breakpoint
DO $do$
DECLARE
  f record;
  def text;
  n int := 0;
BEGIN
  FOR f IN
    SELECT p.oid, p.proname::text AS name
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname NOT IN ('mantle_acl_on', 'mantle_acl_saved', 'mantle_acl_restore', 'mantle_acl_signed')
       AND (p.prosrc LIKE '%"public"."mantle_acl_on"()%' OR p.prosrc LIKE '%"public"."mantle_acl_saved"()%'
            OR p.prosrc LIKE '%"public"."mantle_acl_restore"(%' OR p.prosrc LIKE '%"public"."mantle_acl_signed"()%')
  LOOP
    def := pg_catalog.pg_get_functiondef(f.oid);
    def := replace(def, '"public"."mantle_acl_saved"()',
                   'coalesce(current_setting(''mantle.acl_internal'', true), '''')');
    def := replace(def, '"public"."mantle_acl_on"()', 'set_config(''mantle.acl_internal'', ''on'', true)');
    def := replace(def, '"public"."mantle_acl_restore"(was)', 'set_config(''mantle.acl_internal'', was, true)');
    def := replace(def, '"public"."mantle_acl_restore"('''')', 'set_config(''mantle.acl_internal'', '''', true)');
    def := replace(def, '"public"."mantle_acl_signed"()', '"public"."mantle_acl_internal"()');
    IF def ~ '"public"\."mantle_acl_(on|saved|restore|signed)"' THEN
      RAISE EXCEPTION '0326 revert: % calls a flag helper in a form not put back', f.name;
    END IF;
    EXECUTE def;
    n := n + 1;
  END LOOP;
  IF n <> 11 THEN
    RAISE EXCEPTION '0326 revert: put back % bodies, expected 11 (nine setters, two triggers)', n;
  END IF;
END
$do$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_acl_signed"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_acl_restore"(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_acl_saved"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_acl_on"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_miss_guard_trg" ON "public"."actor_check_misses";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_miss_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."access_keys";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."oauth_access_tokens";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."mobile_tokens";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."oauth_auth_codes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."oauth_clients";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_token_hold"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_client_held"(uuid);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_login_hold_trg" ON "auth"."users";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_login_hold"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_login_held"(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_member_turn_settle"(text, bigint);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_member_turn_claim"(
  turn text, owner uuid, since timestamptz, daily_turns integer, daily_tokens bigint)
  RETURNS TABLE(ok boolean, fresh boolean, reason text, used bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  login uuid := "public"."mantle_scope_login_id"();
  n bigint;
BEGIN
  IF login IS NULL THEN
    RAISE EXCEPTION 'mantle_member_turn_claim: only for the scope''s own login' USING ERRCODE = '42501';
  END IF;
  IF coalesce("mantle_member_turn_claim"."turn", '') = ''
     OR "mantle_member_turn_claim"."owner" IS NULL
     OR "mantle_member_turn_claim"."since" IS NULL
     OR "mantle_member_turn_claim"."daily_turns" IS NULL
     OR "mantle_member_turn_claim"."daily_tokens" IS NULL THEN
    RAISE EXCEPTION 'mantle_member_turn_claim: a missing argument' USING ERRCODE = '22023';
  END IF;
  -- The key claimMemberTurn took before 0325, so an image of either side
  -- waits for the other's claim on the same login.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-turn:' || login::text, 0));
  IF EXISTS (SELECT 1 FROM "public"."member_turn_ledger" l
              WHERE l."turn_id" = "mantle_member_turn_claim"."turn"
                AND l."login_id" IS DISTINCT FROM login) THEN
    RAISE EXCEPTION 'mantle_member_turn_claim: another login''s turn' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."member_turn_ledger" l
              WHERE l."turn_id" = "mantle_member_turn_claim"."turn") THEN
    RETURN QUERY SELECT true, false, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  SELECT count(*) INTO n FROM "public"."member_turn_ledger" l
   WHERE l."login_id" = login AND l."created_at" >= "mantle_member_turn_claim"."since";
  IF n >= "mantle_member_turn_claim"."daily_turns" THEN
    RETURN QUERY SELECT false, false, 'daily_cap'::text, n;
    RETURN;
  END IF;
  IF "mantle_member_turn_claim"."daily_tokens" > 0 THEN
    SELECT coalesce(sum(t."tokens_in" + t."tokens_out"), 0)::bigint INTO n
      FROM "public"."traces" t
     WHERE t."owner_id" = "mantle_member_turn_claim"."owner"
       AND t."kind" = 'responder_turn'
       AND t."started_at" >= "mantle_member_turn_claim"."since"
       AND t."subject_kind" = 'team_turn'
       AND t."data" ->> 'login_id' = login::text;
    IF n >= "mantle_member_turn_claim"."daily_tokens" THEN
      RETURN QUERY SELECT false, false, 'token_budget'::text, n;
      RETURN;
    END IF;
  END IF;
  INSERT INTO "public"."member_turn_ledger" ("turn_id", "owner_id", "login_id")
  VALUES ("mantle_member_turn_claim"."turn", "mantle_member_turn_claim"."owner", login)
  ON CONFLICT ("turn_id") DO NOTHING;
  -- Housekeeping on the login's own rows: the cap reads one day.
  DELETE FROM "public"."member_turn_ledger" l
   WHERE l."login_id" = login AND l."created_at" < now() - interval '7 days';
  RETURN QUERY SELECT true, true, NULL::text, NULL::bigint;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_member_turn_claim"(text, uuid, timestamptz, integer, bigint) FROM PUBLIC;
--> statement-breakpoint
-- migrate's derived would-refuse trigger names the column (0319's
-- UPDATE OF list); the next migrate derives it again from the grants.
DROP TRIGGER IF EXISTS "mantle_narrow_would_refuse_upd" ON "public"."member_turn_ledger";
--> statement-breakpoint
ALTER TABLE "public"."member_turn_ledger" DROP COLUMN IF EXISTS "tokens";
--> statement-breakpoint
-- Off the ledger: the next roll forward applies 0326 again (re-runnable).
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790198920000;
