-- The narrow system role's report-only branch goes (plan v3.2 S7c). Every
-- box runs the narrow route since S7b (the switch MANTLE_NARROW_SYSTEM is
-- gone from the app), so a write a narrow reason makes off that route no
-- longer happens, and the counts that told one (0312, 0318, 0320, 0327,
-- 0328, 0329) read nothing. What stays is what the narrow role is held to:
-- the one-way rules (0319, 0321, 0324, 0325), the message guard (0323), the
-- login and grant holds (0327, 0328) and the miss guard, each refusing the
-- narrow role as before; and narrow-denied, the count of what the role met
-- and lacked (the app's, no trigger).
--
-- 1. The would-refuse count (0320): its derived triggers (migrate made them
--    from the narrow role's grants: mantle_narrow_would_refuse_ins, _del
--    and _upd) and its function. migrate drops them table by table before
--    the pending migrations (runtime-role.ts dropNarrowWouldRefuse),
--    so the loop below finds none on a box; it stays for a database migrated
--    another way. Its derivation and the box's count of missing triggers
--    (0328, 0329) go with it.
-- 2. The cascade count (0312): its three triggers (auth.users, spaces,
--    agents) and its function.
-- 3. mantle_actor_check_stmt: the content count's arm out. A statement with
--    an actor returns at once, as 0277 had it; the miss path is unchanged.
-- 4. mantle_narrow_one_way, mantle_narrow_message_guard,
--    mantle_narrow_login_hold, mantle_narrow_token_hold: the report arm out.
--    Off the narrow role each returns at once (a definer's writes, the full
--    route's spots, every other role), as it did for any write that was not
--    a narrow reason's; on it each refuses as before.
-- 5. The report predicate and what only it read: mantle_narrow_report,
--    mantle_narrow_counted, mantle_narrow_actor.
--
-- The holds' readers (mantle_narrow_login_held, mantle_narrow_client_held)
-- stay: the holds and the app's spot (onLoginHoldSpot) read them.
--
-- No table or row changes; no LLM work. Re-runnable. An older image (the release before)
-- runs on it as it is: its migrate's trigger step finds no count function and
-- makes nothing, its box script reads the counts as absent, and the report
-- notices it printed are never raised. Revert:
-- packages/db/rollback/0344_narrow_observe_removed.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.tgname::text AS tg, t.tgrelid::regclass::text AS rel
      FROM pg_catalog.pg_trigger t
     WHERE NOT t.tgisinternal
       AND (t.tgname IN ('mantle_narrow_would_refuse_ins', 'mantle_narrow_would_refuse_del',
                         'mantle_narrow_would_refuse_upd')
            OR t.tgfoid = to_regprocedure('public.mantle_narrow_would_refuse_stmt()'))
     ORDER BY 2, 1
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', r.tg, r.rel);
  END LOOP;
END
$do$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_counter_missing"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_would_refuse_expected"();
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_would_refuse_stmt"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "auth"."users";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "public"."spaces";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mantle_narrow_cascade" ON "public"."agents";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_cascade_stmt"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  seen_key text := 'mantle.actor_missed_' || TG_TABLE_NAME;
  mode text;
BEGIN
  IF coalesce("public"."mantle_identity_actor"(), '') <> '' OR pg_trigger_depth() > 1 THEN
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
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_one_way"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  o jsonb;
  n jsonb;
  arg text;
  kind text;
  col text;
  i int;
BEGIN
  IF current_user <> 'mantle_system_narrow' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD);
  IF TG_OP IN ('UPDATE', 'INSERT') THEN
    n := to_jsonb(NEW);
  END IF;
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
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_one_way"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_message_guard"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  why text;
  o jsonb;
  n jsonb;
  -- What a settled row may still gain: the follow-up suggestion.
  late constant text[] := ARRAY['suggestion', 'suggestedAt'];
BEGIN
  -- As the caller: the narrow role's own writes are checked; a definer's
  -- (current_user its owner) are not.
  IF current_user <> 'mantle_system_narrow' THEN
    RETURN NEW;
  END IF;
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
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_message_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_login_hold"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
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
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_login_hold"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_narrow_token_hold"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
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
  -- The 0327 hold, widened in 0328: a revoke of the owner's or an Admin
  -- user's key, token or device, a delete of their open OAuth code, of an
  -- unclaimed pairing code or of a push device of theirs, a peer taken off
  -- acting as them, and a delete of an MCP client a live grant of theirs
  -- rides on, are held from the narrow role (the users area ends such a
  -- login's sessions at the spot login-credential). And on the narrow role
  -- a key's revoked_by is written only with its revoke, never rewritten on
  -- a key already revoked.
  IF current_user <> 'mantle_system_narrow' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
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
      IF (o -> 'revoked_by') IS DISTINCT FROM (n -> 'revoked_by')
         AND (o ->> 'revoked_at') IS NOT NULL THEN
        RAISE EXCEPTION 'the narrow system role may not rewrite %.revoked_by', TG_TABLE_NAME
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF kind = 'client' THEN
    IF "public"."mantle_narrow_client_held"(id) THEN
      RAISE EXCEPTION 'the narrow system role may not revoke or remove a grant of the owner or an Admin user (%)', TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;
  ELSIF "public"."mantle_narrow_login_held"(id) THEN
    RAISE EXCEPTION 'the narrow system role may not revoke or remove a grant of the owner or an Admin user (%)', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_narrow_token_hold"() FROM PUBLIC;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_report"(text, text, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_counted"(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_narrow_actor"(text);
--> statement-breakpoint
-- The end state: no function in public calls the report branch's.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
               JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.prosrc ~ 'mantle_narrow_(report|counted|actor|would_refuse_stmt|would_refuse_expected|counter_missing|cascade_stmt)"?\s*\(') THEN
    RAISE EXCEPTION '0344: a function still calls the narrow report branch';
  END IF;
END
$do$;
