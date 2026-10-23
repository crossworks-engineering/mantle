-- Three holes the full re-audits found in what the narrow login may
-- write (plan v3.2 S7b part b2), each closed in the database:
--
-- 1. The member token budget read the login's member chat traces (0326),
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
--    reason is counted (0320's one report predicate, mantle_narrow_report,
--    replaced here to name the hold: a role that may not run the held
--    reader, as an older image's runtime role, writes uncounted), not
--    refused. The same hold
--    on their grants (mantle_narrow_token_hold): a revoke of their access
--    key, OAuth token or device token, a delete of their open OAuth code,
--    and a delete of an MCP client a live grant of theirs rides on
--    (mantle_narrow_client_held: the delete cascades). And a key's
--    revoked_by is never rewritten by the narrow role on a key already
--    revoked.
-- 3. actor_check_misses: the narrow role may insert miss rows (its own
--    count), and the box counts start from the latest narrow-epoch row,
--    so a forged epoch (or a row dated ahead) hid every count. The narrow
--    role may now insert neither, directly or through
--    mantle_actor_miss_log: an epoch row comes from migrate or an operator.
-- 4. mantle.acl_internal, the derivation's own flag (0241): the item_grants
--    triggers read it alone (mantle_item_grants_refresh_trg skips the heads
--    check, mantle_item_grants_propagate_trg skips the folder propagation),
--    and any session may set it. Proven on pg18: a write role session (an
--    Admin scope) that set it unshared a folder from a workspace and the
--    folder's item stayed readable there (its folder row kept, read_ws
--    unchanged), with no heads check; the same on the runtime role. Now
--    the derivation's functions (the nine that set the flag, rewritten in
--    place below) sign it: mantle_acl_on() sets the flag 'on' and
--    mantle.acl_sig, a mark keyed by the heads key and this transaction
--    (mantle_heads_mac), and mantle_acl_saved() / mantle_acl_restore() keep
--    and put back both, so the mark is valid only inside such a function.
--    The two triggers ask mantle_acl_signed(): a session's own 'on' (or a
--    mark from another transaction) is the flag off, so the heads check and
--    the propagation run. mantle.acl_internal itself still reads 'on' (the
--    guards pair it with mantle_owner_role(); an older image's marker is
--    the same), so nothing else changes. mantle_acl_flag_leaks() is the
--    catalog check (migrate's leak check reads it with 0322's): a body
--    that sets either key itself, or decides from the flag alone, fails it.
--
-- When the S8b rebase lands, "Admin user" here keeps the Admin workspace's
-- users; the role column test is the older name of the same thing.
--
-- Re-runnable. One column added (member_turn_ledger.tokens, 0 on every
-- row); no other table or row change; eleven function bodies rewritten in
-- place (4), each otherwise as it was; no LLM work. Revert:
-- packages/db/rollback/0327_narrow_lockout_and_ledger_tokens.revert.sql
-- (first, before 0326's). The `when` sits 60000 above 0326's.
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
  -- The key claimMemberTurn took before 0326, so an image of either side
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
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_login_hold"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_login_hold_trg" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_login_hold_trg" BEFORE UPDATE OF "disabled_at", "session_epoch" ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_login_hold"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_client_held"(client uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  -- A definer (it asks mantle_narrow_login_held per row). Whether removing
  -- the MCP client would end a held login's grant: a live token or an open
  -- code of the owner or an Admin user on it (the delete cascades to both).
  -- No identity read.
  SELECT EXISTS (SELECT 1 FROM "public"."oauth_access_tokens" t
                  WHERE t."client_id" = "mantle_narrow_client_held"."client"
                    AND t."revoked_at" IS NULL
                    AND "public"."mantle_narrow_login_held"(t."actor_id"))
      OR EXISTS (SELECT 1 FROM "public"."oauth_auth_codes" c
                  WHERE c."client_id" = "mantle_narrow_client_held"."client"
                    AND "public"."mantle_narrow_login_held"(c."actor_id"))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_client_held"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- 0320's one report predicate, the two holds named: 'login' asks
-- mantle_narrow_login_held(id), 'client' mantle_narrow_client_held(id).
-- Both are definers taken from PUBLIC; an older image's migrate grants the
-- runtime role its own list without them, and the 42501 that a role which
-- may not run one raises answers false here (the write runs, uncounted),
-- never a refusal of a sign-in or sign-out write.
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_report"(who text, held text DEFAULT NULL, id uuid DEFAULT NULL)
  RETURNS boolean LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
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
$$;
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_token_hold"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."access_keys";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_token_hold_trg" BEFORE UPDATE OF "revoked_at", "revoked_by" ON "public"."access_keys"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_token_hold"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."oauth_access_tokens";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_token_hold_trg" BEFORE UPDATE OF "revoked_at" ON "public"."oauth_access_tokens"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_token_hold"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."mobile_tokens";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_token_hold_trg" BEFORE UPDATE OF "revoked_at" ON "public"."mobile_tokens"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_token_hold"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."oauth_auth_codes";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_token_hold_trg" BEFORE DELETE ON "public"."oauth_auth_codes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_token_hold"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_token_hold_trg" ON "public"."oauth_clients";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_token_hold_trg" BEFORE DELETE ON "public"."oauth_clients"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_token_hold"();
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
--> statement-breakpoint
-- 4. The derivation's flag, signed.
CREATE OR REPLACE FUNCTION "public"."mantle_acl_on"()
  RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  mark text := "public"."mantle_heads_mac"('acl_internal');
BEGIN
  IF mark IS NULL THEN
    RAISE EXCEPTION 'mantle_acl_on: no heads key' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('mantle.acl_sig', mark, true);
  RETURN set_config('mantle.acl_internal', 'on', true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_acl_on"() FROM PUBLIC;
--> statement-breakpoint
-- Both keys as they are now, to put back with mantle_acl_restore.
CREATE OR REPLACE FUNCTION "public"."mantle_acl_saved"()
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT jsonb_build_array(coalesce(current_setting('mantle.acl_internal', true), ''),
                           coalesce(current_setting('mantle.acl_sig', true), ''))::text
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_acl_saved"() FROM PUBLIC;
--> statement-breakpoint
-- What mantle_acl_saved kept ('' clears both). Never signs: a flag the
-- session set before stays unsigned when put back.
CREATE OR REPLACE FUNCTION "public"."mantle_acl_restore"(saved text)
  RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  j jsonb := CASE WHEN coalesce(saved, '') = '' THEN '["", ""]'::jsonb ELSE saved::jsonb END;
BEGIN
  PERFORM set_config('mantle.acl_sig', coalesce(j ->> 1, ''), true);
  RETURN set_config('mantle.acl_internal', coalesce(j ->> 0, ''), true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_acl_restore"(text) FROM PUBLIC;
--> statement-breakpoint
-- The flag as one of the derivation's functions set it in this transaction.
CREATE OR REPLACE FUNCTION "public"."mantle_acl_signed"()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE WHEN coalesce(current_setting('mantle.acl_internal', true), '') <> 'on'
                OR coalesce(current_setting('mantle.acl_sig', true), '') = '' THEN false
              ELSE coalesce(current_setting('mantle.acl_sig', true)
                            = "public"."mantle_heads_mac"('acl_internal'), false) END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_acl_signed"() FROM PUBLIC;
--> statement-breakpoint
-- The nine functions that set the flag, and the two triggers that read it
-- alone, rewritten in place: otherwise byte for byte as they were (the
-- revert puts them back the same way). The end state is asserted, so a
-- second run (which rewrites none) passes.
DO $do$
DECLARE
  f record;
  def text;
  got text[] := '{}';
  setters constant text[] := ARRAY[
    'mantle_acl_refresh', 'mantle_bridge_apply', 'mantle_facts_freeze_trg',
    'mantle_nodes_acl_after_ins_trg', 'mantle_nodes_reown_home_trg', 'mantle_rederive_nodes',
    'mantle_ws_bridge_off', 'mantle_ws_migrate_bridged', 'mantle_ws_spaces_fold'];
  readers constant text[] := ARRAY['mantle_item_grants_refresh_trg', 'mantle_item_grants_propagate_trg'];
BEGIN
  FOR f IN
    SELECT p.oid, p.proname::text AS name
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND ((p.prosrc LIKE '%set_config(''mantle.acl_internal''%'
             AND p.proname NOT IN ('mantle_acl_on', 'mantle_acl_restore'))
            OR (p.proname = ANY (readers) AND p.prosrc LIKE '%"public"."mantle_acl_internal"()%'))
  LOOP
    def := pg_catalog.pg_get_functiondef(f.oid);
    def := replace(def, 'coalesce(current_setting(''mantle.acl_internal'', true), '''')',
                   '"public"."mantle_acl_saved"()');
    def := replace(def, 'set_config(''mantle.acl_internal'', ''on'', true)', '"public"."mantle_acl_on"()');
    def := replace(def, 'set_config(''mantle.acl_internal'', was, true)', '"public"."mantle_acl_restore"(was)');
    def := replace(def, 'set_config(''mantle.acl_internal'', '''', true)', '"public"."mantle_acl_restore"('''')');
    IF f.name = ANY (readers) THEN
      def := replace(def, '"public"."mantle_acl_internal"()', '"public"."mantle_acl_signed"()');
    END IF;
    IF def LIKE '%set_config(''mantle.acl_internal''%' OR def LIKE '%current_setting(''mantle.acl_internal''%'
       OR def LIKE '%"public"."mantle_acl_internal"()%' THEN
      RAISE EXCEPTION '0327: % sets or reads the derivation flag in a form not rewritten', f.name;
    END IF;
    EXECUTE def;
    got := got || f.name;
  END LOOP;
  IF EXISTS (SELECT 1 FROM unnest(got) x WHERE x <> ALL (setters || readers)) THEN
    RAISE EXCEPTION '0327: rewrote %, expected only % and %', got, setters, readers;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(setters || readers) w
              WHERE NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_proc p
                  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = w)) THEN
    RAISE EXCEPTION '0327: one of % or % is missing', setters, readers;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
               JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = ANY (setters)
                AND p.prosrc NOT LIKE '%"public"."mantle_acl_on"()%') THEN
    RAISE EXCEPTION '0327: a function of % does not sign the flag', setters;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
               JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = ANY (readers)
                AND p.prosrc NOT LIKE '%"public"."mantle_acl_signed"()%') THEN
    RAISE EXCEPTION '0327: a trigger of % does not ask for the signed flag', readers;
  END IF;
END
$do$;
--> statement-breakpoint
-- The catalog check of the flag (migrate fails on a row, with 0322's; a
-- key built at run time is 0322's to find).
CREATE OR REPLACE FUNCTION "public"."mantle_acl_flag_leaks"()
  RETURNS TABLE (kind text, object text, detail text)
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  -- Set the flag or the mark: these two only.
  setters constant text[] := ARRAY['public.mantle_acl_on()', 'public.mantle_acl_restore(text)'];
  -- Read the flag or the mark for its value: the marker itself, the save
  -- and the signed test.
  readers constant text[] := ARRAY['public.mantle_acl_internal()', 'public.mantle_acl_saved()',
                                   'public.mantle_acl_signed()'];
  -- Name the marker without deciding from it alone: mantle_owner_role()
  -- (asks for its owner), mantle_acl_writer() (pairs it with
  -- mantle_owner_role()).
  pairs constant text[] := ARRAY['public.mantle_owner_role()', 'public.mantle_acl_writer()'];
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure::text AS sig,
           p.prosrc || ' ' || coalesce(pg_get_function_sqlbody(p.oid), '') AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       AND NOT (n.nspname = 'public' AND p.proname IN ('mantle_acl_flag_leaks', 'mantle_identity_leaks'))
  LOOP
    IF f.src ~* 'set_config"?\s*\(\s*''mantle\.acl_(internal|sig)''' AND NOT (f.sig = ANY (setters)) THEN
      kind := 'function'; object := f.sig;
      detail := 'sets the derivation flag itself (mantle_acl_on and mantle_acl_restore only)';
      RETURN NEXT;
    END IF;
    IF f.src ~* 'current_setting"?\s*\(\s*''mantle\.acl_(internal|sig)''' AND NOT (f.sig = ANY (readers)) THEN
      kind := 'function'; object := f.sig;
      detail := 'reads the derivation flag itself (ask mantle_acl_signed, or mantle_acl_writer)';
      RETURN NEXT;
    END IF;
    IF f.src ~* 'mantle_acl_internal"?\s*\(' AND NOT (f.sig = ANY (readers || pairs)) THEN
      kind := 'function'; object := f.sig;
      detail := 'decides from the derivation flag alone (ask mantle_acl_signed, or mantle_acl_writer)';
      RETURN NEXT;
    END IF;
  END LOOP;
  FOR f IN
    SELECT 'policy' AS k, pol.polrelid::regclass::text || ' ' || pol.polname AS obj,
           coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' '
             || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS src
      FROM pg_policy pol
    UNION ALL
    SELECT 'trigger', t.tgrelid::regclass::text || ' ' || t.tgname, pg_get_triggerdef(t.oid)
      FROM pg_trigger t WHERE NOT t.tgisinternal
    UNION ALL
    SELECT 'default', a.adrelid::regclass::text, pg_get_expr(a.adbin, a.adrelid) FROM pg_attrdef a
    UNION ALL
    SELECT 'check', c.conrelid::regclass::text || ' ' || c.conname, pg_get_constraintdef(c.oid)
      FROM pg_constraint c WHERE c.contype = 'c'
    UNION ALL
    SELECT 'view', r.ev_class::regclass::text, pg_get_ruledef(r.oid)
      FROM pg_rewrite r JOIN pg_class cl ON cl.oid = r.ev_class
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_'
  LOOP
    IF f.src ~* 'mantle\.acl_(internal|sig)|mantle_acl_internal"?\s*\(' THEN
      kind := f.k; object := f.obj; detail := 'reads the derivation flag (only the functions above may)';
      RETURN NEXT;
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_acl_flag_leaks"() FROM PUBLIC;
