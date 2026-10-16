-- The check modes' floor (pre-check deletion, A4 step 4 and A5 step 6b;
-- docs/actors.md, "Pre-check deletion"). Once a tool's TypeScript item
-- pre-check is gone, the database's actor and edit checks are the only edit
-- check of its write: a box whose checks are lowered to warn or off makes
-- what on refuses. So lowering a check is an operator's explicit, recorded
-- act, never a slip:
--
-- 1. mantle_set_check(setting, mode, tries, reason) refuses to LOWER a
--    check's box mode (on to warn or off, warn to off) unless `reason`
--    names why (42501, nothing changed). A lowering with a reason raises a
--    WARNING (the server log) and records itself in the database setting
--    mantle.check_lowered: one entry per lowered check (when, which check,
--    from, to, the session user, the reason), ' | ' between two. Raising
--    needs no reason; a check raised to on drops its entry, and once both
--    checks are on the record is cleared. mantle_set_actor_check and
--    mantle_set_edit_check
--    take the same fourth argument; their two-argument forms are dropped
--    first, so a call is never ambiguous.
-- 2. mantle_check_lowered(): the record, or '' (none). The app reads it with
--    the box modes and logs loudly while a check is below on
--    (packages/db/src/client.ts); migrate raises a check that is below on
--    with no entry covering its mode (a new database, a restore, a bare
--    ALTER DATABASE, also one below a recorded lowering) to on, unless the
--    box says MANTLE_CHECK_FLOOR=keep (packages/db/src/check-floor.ts).
--    mantle_check_note(setting, entry) replaces one check's entry (NULL
--    drops it): the setter's, and migrate's under keep.
--
-- No table lock, no row change. Re-runnable. The `when` sits above 0297's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_check_lowered"()
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT coalesce((
    SELECT substr(c, length('mantle.check_lowered=') + 1)
      FROM pg_db_role_setting d, unnest(d.setconfig) AS c
     WHERE d.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND d.setrole = 0 AND c LIKE 'mantle.check\_lowered=%'
     LIMIT 1), '')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_check_lowered"() FROM PUBLIC;
--> statement-breakpoint
-- One check's entry in the record, replaced (`entry` NULL: dropped). The
-- other check's entry stays, so two lowerings are both on record.
CREATE OR REPLACE FUNCTION "public"."mantle_check_note"(setting text, entry text)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  kept text[];
BEGIN
  IF setting IS NULL OR setting NOT IN ('actor_check', 'edit_check') THEN
    RAISE EXCEPTION 'mantle_check_note: actor_check or edit_check' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(u.e ORDER BY u.o), '{}'::text[]) INTO kept
    FROM unnest(string_to_array(nullif("public"."mantle_check_lowered"(), ''), ' | '))
         WITH ORDINALITY AS u(e, o)
   WHERE position(' mantle.' || setting || ' ' in u.e) = 0;
  IF entry IS NOT NULL THEN
    kept := kept || replace(regexp_replace(entry, '[[:cntrl:]]+', ' ', 'g'), '|', '/');
  END IF;
  IF cardinality(kept) = 0 THEN
    EXECUTE format('ALTER DATABASE %I RESET mantle.check_lowered', current_database());
  ELSE
    EXECUTE format('ALTER DATABASE %I SET mantle.check_lowered = %L', current_database(),
      array_to_string(kept, ' | '));
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_check_note"(text, text) FROM PUBLIC;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_set_actor_check"(text, integer);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_set_edit_check"(text, integer);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_set_check"(text, text, integer);
--> statement-breakpoint
-- The one way to change a check's box mode (docs/update-prod.md): 0280's,
-- with the floor. Run it as the superuser that runs the migrations.
CREATE OR REPLACE FUNCTION "public"."mantle_set_check"(
  setting text, mode text, tries integer DEFAULT 50, reason text DEFAULT NULL)
  RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  cur text;
  why text := btrim(regexp_replace(coalesce(reason, ''), '[[:cntrl:]]+', ' ', 'g'));
  rank_cur int;
  rank_new int;
BEGIN
  IF setting IS NULL OR setting NOT IN ('actor_check', 'edit_check') THEN
    RAISE EXCEPTION 'mantle_set_check: actor_check or edit_check' USING ERRCODE = '22023';
  END IF;
  IF mode IS NULL OR mode NOT IN ('off', 'warn', 'on') THEN
    RAISE EXCEPTION 'mantle_set_check: mode must be off, warn or on' USING ERRCODE = '22023';
  END IF;
  cur := "public"."mantle_check_box_mode"(setting);
  rank_cur := CASE cur WHEN 'warn' THEN 1 WHEN 'on' THEN 2 ELSE 0 END;
  rank_new := CASE mode WHEN 'warn' THEN 1 WHEN 'on' THEN 2 ELSE 0 END;
  IF rank_new < rank_cur THEN
    IF why = '' THEN
      RAISE EXCEPTION 'mantle_set_check: lowering mantle.% from % to % needs a reason', setting, cur, mode
        USING ERRCODE = '42501',
              HINT = format('The item pre-checks are gone: below on, a tool write the database would refuse is made. '
                            'For an emergency only: select mantle_set_%s(%L, 50, %L); (docs/update-prod.md)',
                            setting, mode, 'why, in a few words');
    END IF;
    why := left(why, 200);
    RAISE WARNING 'mantle check lowered: mantle.% from % to % by %: %', setting, cur, mode, session_user, why;
    PERFORM "public"."mantle_check_note"(setting,
      format('%s mantle.%s %s to %s by %s: %s',
             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             setting, cur, mode, session_user, why));
  END IF;
  IF setting = 'actor_check' THEN
    PERFORM "public"."mantle_actor_check_triggers"(mode <> 'off', tries);
  ELSE
    PERFORM "public"."mantle_edit_check_triggers"(mode <> 'off', tries);
  END IF;
  IF mode = 'off' THEN
    EXECUTE format('ALTER DATABASE %I RESET mantle.%s', current_database(), setting);
  ELSE
    EXECUTE format('ALTER DATABASE %I SET mantle.%s = %L', current_database(), setting, mode);
  END IF;
  -- On again: this check's entry is history, dropped; both on, the whole
  -- record is cleared.
  IF mode = 'on' THEN
    PERFORM "public"."mantle_check_note"(setting, NULL);
  END IF;
  IF "public"."mantle_check_box_mode"('actor_check') = 'on'
     AND "public"."mantle_check_box_mode"('edit_check') = 'on' THEN
    EXECUTE format('ALTER DATABASE %I RESET mantle.check_lowered', current_database());
  END IF;
  RETURN mode;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_set_edit_check"(
  mode text, tries integer DEFAULT 50, reason text DEFAULT NULL)
  RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_set_check"('edit_check', mode, tries, reason)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_set_actor_check"(
  mode text, tries integer DEFAULT 50, reason text DEFAULT NULL)
  RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_set_check"('actor_check', mode, tries, reason)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_set_check"(text, text, integer, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_set_edit_check"(text, integer, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_set_actor_check"(text, integer, text) FROM PUBLIC;
