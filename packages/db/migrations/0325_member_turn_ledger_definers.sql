-- The member turn ledger behind two definers bound to the identity gateway
-- (plan v3.2 S7b part b2, round 14d; the CEO's call on the ledger).
--
-- A login that is not an Admin user takes a slot of its daily turn cap and
-- token budget for each chat turn, summary and transcription (audit F09,
-- member_turn_ledger, 0182). The slot was written and given back by the
-- app's own statements on the system pool. Inside a member's chat request
-- that is the narrow route with the switch on, where the narrow role holds
-- no right on the table (refused, 42501); granting it INSERT and DELETE
-- would let a forged narrow session clear any login's daily cap.
--
-- Now the ledger is written only here:
--
-- 1. mantle_member_turn_claim(turn, owner, since, daily_turns,
--    daily_tokens): the whole claim in one call, as claimMemberTurn did
--    it (the per-login advisory lock, a turn id already claimed admitted
--    and not counted again, the day's turns against the cap, the login's
--    member chat tokens against the budget, the row, the login's own rows
--    older than a week pruned). The login is never an argument: it is the
--    scope's own login from the identity gateway (mantle_scope_login_id),
--    which the app sets on the system pool for that login only
--    (packages/db member-turn-tx.ts: the request's own login, or the
--    paired login of a Telegram chat). A turn id another login claimed is
--    refused.
-- 2. mantle_member_turn_release(turn): gives back the slot of a turn whose
--    enqueue failed: only the scope login's own row with that id, and only
--    one made in the last five minutes (the turn's own window: the release
--    runs right after the failed enqueue). An older row, or another
--    login's, is left (false).
--
-- On the narrow role the identity readers answer no login (0321), so both
-- refuse there by construction; the narrow role may not EXECUTE them
-- either (runtime-role.ts NARROW_DENIED_FUNCTIONS), and holds no right on
-- the table (access-matrix.ts NARROW_WRITES has no entry). The runtime role
-- runs them (RUNTIME_SYSTEM_FUNCTIONS) and now only reads the table
-- (access-matrix.ts runtime 'read': migrate takes its INSERT, UPDATE and
-- DELETE). No viewer role and not the write role may run them.
--
-- An image before this one writes the table itself; its own migrate grants
-- the runtime role the writes again, so rolling back one image needs no
-- revert (the functions stay, unused). No table or row changes; no LLM
-- work. Re-runnable. The `when` sits above 0324's. Revert:
-- packages/db/rollback/0325_member_turn_ledger_definers.revert.sql (first,
-- before 0324's).
SET LOCAL lock_timeout = '30s';
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
CREATE OR REPLACE FUNCTION "public"."mantle_member_turn_release"(turn text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  login uuid := "public"."mantle_scope_login_id"();
  gone integer;
BEGIN
  IF login IS NULL THEN
    RAISE EXCEPTION 'mantle_member_turn_release: only for the scope''s own login' USING ERRCODE = '42501';
  END IF;
  DELETE FROM "public"."member_turn_ledger" l
   WHERE l."turn_id" = "mantle_member_turn_release"."turn"
     AND l."login_id" = login
     AND l."created_at" > now() - interval '5 minutes';
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone > 0;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_member_turn_release"(text) FROM PUBLIC;
