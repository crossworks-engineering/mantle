-- Three holes the full re-audits found in what the narrow login may
-- write (plan v3.2 S7b part b2), each closed in the database:
--
-- 1. The member token budget read the login's member chat traces (0325),
--    a table the narrow role may update and insert: a forged narrow
--    session could lower its own tokens (or take its traces' login away)
--    to pass the budget, or raise another login's to lock it out of its
--    chat. The budget now reads the member turn ledger, which the narrow
--    role may not write at all: each slot keeps its turn's model tokens
--    (in + out), stamped at the turn's close by
--    mantle_member_turn_settle(turn, tokens) for the scope's own login only
--    (the identity gateway, never an argument), only upwards. The runtime
--    role runs it (runtime-role.ts RUNTIME_SYSTEM_FUNCTIONS); the narrow
--    role may not (NARROW_DENIED_FUNCTIONS, and the readers answer it no
--    login). mantle_member_turn_claim sums the ledger's tokens instead of
--    the traces'. A slot claimed before this release carries 0 tokens: the
--    budget restarts from the day this lands (it reads one day).
-- 2. auth.users.disabled_at and session_epoch: the narrow role may update
--    both (the users area disables a login and ends its sessions), so it
--    could disable the brain owner and every Admin user, or end their
--    sessions over and over. mantle_narrow_login_hold refuses the narrow
--    role either column on a held login: the owner, a login whose role is
--    admin, or a user of the Admin workspace (a disabled one too:
--    mantle_narrow_login_held). The users area's disable and session end of
--    such a login run at the full-route spot login-credential (the app asks
--    the same definer). Off the narrow route the same change by a narrow
--    reason is counted (0319's report branch), not refused.
-- 3. actor_check_misses: the narrow role may insert miss rows (its own
--    count), and the box counts start from the latest narrow-epoch row,
--    so a forged epoch (or a row dated ahead) hid every count. The narrow
--    role may now insert neither, directly or through
--    mantle_actor_miss_log: an epoch row comes from migrate or an operator.
--
-- When the S8b rebase lands, "Admin user" here keeps the Admin workspace's
-- users; the role column test is the older name of the same thing.
--
-- Re-runnable. One column added (member_turn_ledger.tokens, 0 on every
-- row); no other table or row change; no LLM work. Revert:
-- packages/db/rollback/0326_narrow_lockout_and_ledger_tokens.revert.sql
-- (first, before 0325's). The `when` sits 60000 above 0325's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."member_turn_ledger" ADD COLUMN IF NOT EXISTS "tokens" bigint DEFAULT 0 NOT NULL;
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
    -- The slots' own tokens (mantle_member_turn_settle), never the traces:
    -- the narrow role writes traces, not this table.
    SELECT coalesce(sum(l."tokens"), 0)::bigint INTO n
      FROM "public"."member_turn_ledger" l
     WHERE l."login_id" = login
       AND l."owner_id" = "mantle_member_turn_claim"."owner"
       AND l."created_at" >= "mantle_member_turn_claim"."since";
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
CREATE OR REPLACE FUNCTION "public"."mantle_member_turn_settle"(turn text, tokens bigint)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  login uuid := "public"."mantle_scope_login_id"();
  hit integer;
BEGIN
  IF login IS NULL THEN
    RAISE EXCEPTION 'mantle_member_turn_settle: only for the scope''s own login' USING ERRCODE = '42501';
  END IF;
  IF coalesce("mantle_member_turn_settle"."turn", '') = ''
     OR "mantle_member_turn_settle"."tokens" IS NULL
     OR "mantle_member_turn_settle"."tokens" < 0 THEN
    RAISE EXCEPTION 'mantle_member_turn_settle: a missing or negative argument' USING ERRCODE = '22023';
  END IF;
  -- Only up: a retried close writes the same count or more, never less.
  UPDATE "public"."member_turn_ledger" l
     SET "tokens" = greatest(l."tokens", "mantle_member_turn_settle"."tokens")
   WHERE l."turn_id" = "mantle_member_turn_settle"."turn"
     AND l."login_id" = login;
  GET DIAGNOSTICS hit = ROW_COUNT;
  RETURN hit > 0;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_member_turn_settle"(text, bigint) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_login_held"(login uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  -- A definer: it reads workspace_users, which the narrow role may not read
  -- whole. Whether the login's sign-in is held from the narrow role: the
  -- owner, an admin by role, or a user of the Admin workspace (disabled or
  -- not). No identity read.
  SELECT EXISTS (SELECT 1 FROM "auth"."users" l
                  WHERE l."id" = "mantle_narrow_login_held"."login"
                    AND (l."is_owner" OR l."role" = 'admin'))
      OR EXISTS (SELECT 1 FROM "public"."workspace_users" u
                   JOIN "public"."workspaces" w ON w."id" = u."workspace_id" AND w."is_admin"
                  WHERE u."login_id" = "mantle_narrow_login_held"."login")
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_login_held"(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_login_hold"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  who text := coalesce("public"."mantle_identity_actor"(), '');
  own_role text := CASE WHEN current_setting('role') = 'none' THEN session_user::text
                        ELSE current_setting('role') END;
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
  -- Report only (0319): the same change by a narrow reason's actor off the
  -- narrow route, not at a spot, is counted as one the role would refuse.
  -- Nested, so the held test (a definer call) runs only for such a write.
  IF "public"."mantle_narrow_counted"(who)
     AND current_user::text = own_role
     AND coalesce(current_setting('mantle.route', true), '') <> 'full' THEN
    IF "public"."mantle_narrow_login_held"(OLD."id") THEN
      RAISE NOTICE 'mantle narrow write: narrow-would-refuse % auth.users UPDATE', who;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_login_hold"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_login_hold_trg" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_login_hold_trg" BEFORE UPDATE OF "disabled_at", "session_epoch" ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_login_hold"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_miss_guard"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  own_role text := CASE WHEN current_setting('role') = 'none' THEN session_user::text
                        ELSE current_setting('role') END;
BEGIN
  -- The session's own role, so mantle_actor_miss_log (a definer) is
  -- covered too: the narrow login writes no epoch and no row dated ahead.
  IF own_role = 'mantle_system_narrow'
     AND (NEW."check_name" = 'narrow-epoch' OR NEW."at" > now() + interval '1 minute') THEN
    RAISE EXCEPTION 'the narrow system role may not write a count epoch or a miss dated ahead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_miss_guard"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_miss_guard_trg" ON "public"."actor_check_misses";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_miss_guard_trg" BEFORE INSERT OR UPDATE ON "public"."actor_check_misses"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_miss_guard"();
