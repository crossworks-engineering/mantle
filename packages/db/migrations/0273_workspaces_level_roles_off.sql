-- Workspaces W8c: the old access-level model leaves the code, and the old
-- pool roles lose what they could read. Since W5b2 no request or turn reads
-- on a level role, and since W6b none on the personal-space role; the code
-- now opens no pool for them at all (viewer-roles.ts RETIRED_POOL_ROLES:
-- every migrate makes them NOLOGIN with no password).
--
-- 1. The old per-login MCP switch (mcp_login_access, archived and frozen by
--    0268) is checked against its archive and dropped: every row of it must
--    be in archive_mcp_login_access with the same switches, and every
--    archive row missing from it must belong to a login that is gone (a
--    deleted login's row went with it, 0268). Anything else raises and the
--    whole migration rolls back. Its freeze trigger function goes with it.
-- 2. Every row policy of mantle_view_team, mantle_view_client,
--    mantle_view_public and mantle_view_space is dropped, and every right
--    they hold (tables, columns, sequences, functions, the schemas) is
--    revoked. The roles stay, NOLOGIN: the released migrations name them.
--    applyViewerGrants (access-matrix.ts) revokes the same again after
--    every migrate, so a fresh install that ran the old grants ends equal.
-- 3. The old-level functions that nothing calls once those policies are
--    gone are dropped: mantle_viewer_audiences, mantle_item_team_reads,
--    mantle_space_id, mantle_client_space, mantle_client_request_node and
--    mantle_member_space_node. Found by pg_depend (the policies were their
--    only dependents) and by a scan of every function body; the scan runs
--    here again and raises if any function left still names one.
-- 4. The retired client chat's agent (`client-responder`, retired in W5c,
--    its logins gone in W8a) is disabled on every brain, by slug: a
--    responder on no workspace that answers nobody any more (W8
--    integration). Nothing is deleted: the row, its groups and its prompt
--    stay, and `enabled = true` brings it back.
--
-- Kept, on purpose: the level columns and their data, the archives, the
-- spaces tables, mantle_view_user, and everything the switch of a brain not
-- yet on workspaces needs (mantle_ws_migrate_locked and the 0251 bridge
-- pass, mantle_ws_reach_diff, the switch functions, the bridge triggers
-- such a brain still carries, the freeze triggers). mantle_workspace_kind
-- stays for that reason: the bridge pass (mantle_team_reads,
-- mantle_inherited_level, mantle_embedded_level) and the nodes level
-- CHECKs call it. W10 drops the rest.
--
-- Every drop is RESTRICT. No row of any content table changes (step 4
-- touches one agents row a brain), no LLM work is queued and no notify
-- fires.
--
-- Re-runnable: each step reads only what is still there (the table, a
-- policy, a function, an enabled client-responder), so a second run
-- changes nothing.
--
-- The `when` sits above 1790195580000 (0272's): migrate.ts skips a
-- migration whose `when` is at or below the highest one applied.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Every table this migration changes, in one statement with a short wait
-- and a retry (as 0272): a DROP POLICY takes its table's ACCESS EXCLUSIVE
-- lock, and waiting on one table while holding the others would stall
-- every reader. The list is what is still there: a second run locks
-- nothing.
DO $$
DECLARE
  attempt int := 0;
  targets text;
BEGIN
  SELECT string_agg(DISTINCT format('%I.%I', p."schemaname", p."tablename"), ', ')
    INTO targets
    FROM pg_policies p
   WHERE cardinality(p."roles") > 0
     AND p."roles" <@ ARRAY['mantle_view_team', 'mantle_view_client', 'mantle_view_public',
                           'mantle_view_space']::name[];
  IF to_regclass('public.mcp_login_access') IS NOT NULL THEN
    targets := concat_ws(', ', targets, '"public"."mcp_login_access"');
  END IF;
  IF targets IS NULL OR targets = '' THEN RETURN; END IF;
  LOOP
    attempt := attempt + 1;
    BEGIN
      EXECUTE 'LOCK TABLE ' || targets || ' IN ACCESS EXCLUSIVE MODE';
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= 20 THEN
        RAISE EXCEPTION '0273: the tables stayed busy for 20 attempts; run the migration again at a quieter time'
          USING ERRCODE = 'lock_not_available';
      END IF;
      RAISE NOTICE '0273: tables busy (attempt %), retrying', attempt;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── 1. The old per-login MCP switch ──────────────────────────────────────────

DO $$
DECLARE
  live bigint;
  missing bigint;
  extra bigint;
BEGIN
  IF to_regclass('public.mcp_login_access') IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO live FROM "public"."mcp_login_access";
  SELECT count(*) INTO missing
    FROM "public"."mcp_login_access" m
   WHERE NOT EXISTS (SELECT 1 FROM "public"."archive_mcp_login_access" a
                      WHERE a."login_id" = m."login_id"
                        AND a."enabled" = m."enabled"
                        AND a."write_enabled" = m."write_enabled");
  SELECT count(*) INTO extra
    FROM "public"."archive_mcp_login_access" a
   WHERE NOT EXISTS (SELECT 1 FROM "public"."mcp_login_access" m WHERE m."login_id" = a."login_id")
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u."id" = a."login_id");
  IF missing <> 0 OR extra <> 0 THEN
    RAISE EXCEPTION '0273: archive_mcp_login_access does not equal mcp_login_access (% live rows, % not archived as they are, % archived for a login that still exists without a row); nothing was dropped',
      live, missing, extra
      USING ERRCODE = 'check_violation';
  END IF;
  DROP TABLE "public"."mcp_login_access" RESTRICT;
  RAISE NOTICE '0273: mcp_login_access dropped (% rows, all archived)', live;
END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_mcp_login_access_frozen_trg"() RESTRICT;
--> statement-breakpoint

-- ── 2. The old pool roles: no policy, no right ───────────────────────────────

DO $$
DECLARE
  p record;
  n int := 0;
BEGIN
  FOR p IN
    SELECT "schemaname", "tablename", "policyname"
      FROM pg_policies
     WHERE cardinality("roles") > 0
       AND "roles" <@ ARRAY['mantle_view_team', 'mantle_view_client', 'mantle_view_public',
                           'mantle_view_space']::name[]
     ORDER BY 1, 2, 3
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p."policyname", p."schemaname", p."tablename");
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0273: % row policies of the old pool roles dropped', n;
END
$$;
--> statement-breakpoint
-- The roles exist on every brain: migrate creates them before the
-- migrations (ensureViewerRoles), NOLOGIN.
REVOKE ALL ON ALL TABLES IN SCHEMA "public", "auth"
  FROM "mantle_view_team", "mantle_view_client", "mantle_view_public", "mantle_view_space";
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public", "auth"
  FROM "mantle_view_team", "mantle_view_client", "mantle_view_public", "mantle_view_space";
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "public", "auth"
  FROM "mantle_view_team", "mantle_view_client", "mantle_view_public", "mantle_view_space";
--> statement-breakpoint
REVOKE ALL ON SCHEMA "public", "auth"
  FROM "mantle_view_team", "mantle_view_client", "mantle_view_public", "mantle_view_space";
--> statement-breakpoint
DO $$
DECLARE
  left_policies bigint;
  left_rights bigint;
BEGIN
  SELECT count(*) INTO left_policies FROM pg_policies p
   WHERE p."roles" && ARRAY['mantle_view_team', 'mantle_view_client', 'mantle_view_public',
                           'mantle_view_space']::name[];
  SELECT (SELECT count(*) FROM information_schema.role_table_grants g
           WHERE g."grantee" IN ('mantle_view_team', 'mantle_view_client', 'mantle_view_public', 'mantle_view_space'))
       + (SELECT count(*) FROM information_schema.column_privileges g
           WHERE g."grantee" IN ('mantle_view_team', 'mantle_view_client', 'mantle_view_public', 'mantle_view_space'))
       + (SELECT count(*) FROM information_schema.routine_privileges g
           WHERE g."grantee" IN ('mantle_view_team', 'mantle_view_client', 'mantle_view_public', 'mantle_view_space'))
    INTO left_rights;
  IF left_policies <> 0 OR left_rights <> 0 THEN
    RAISE EXCEPTION '0273: the old pool roles still hold % policies and % rights', left_policies, left_rights
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint

-- ── 3. The old-level functions nothing calls any more ────────────────────────

DO $$
DECLARE
  gone CONSTANT text[] := ARRAY[
    'mantle_viewer_audiences', 'mantle_item_team_reads', 'mantle_space_id',
    'mantle_client_space', 'mantle_client_request_node', 'mantle_member_space_node'];
  f record;
  g text;
BEGIN
  -- The body scan: no function that stays may name one that goes.
  FOR f IN
    SELECT p."oid"::regprocedure::text AS "sig", p."proname", p."prosrc"
      FROM pg_proc p
      JOIN pg_namespace ns ON ns."oid" = p."pronamespace"
     WHERE ns."nspname" IN ('public', 'auth')
       AND NOT (p."proname" = ANY (gone))
  LOOP
    FOREACH g IN ARRAY gone LOOP
      IF f."prosrc" ~ ('\m' || g || '\M') THEN
        RAISE EXCEPTION '0273: % still calls %; nothing was dropped', f."sig", g
          USING ERRCODE = 'dependent_objects_still_exist';
      END IF;
    END LOOP;
  END LOOP;
END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_viewer_audiences"() RESTRICT;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_item_team_reads"(uuid[], uuid, uuid, node_type, text, text, text, uuid) RESTRICT;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_client_request_node"(uuid) RESTRICT;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_client_space"(uuid) RESTRICT;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_member_space_node"(uuid) RESTRICT;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_space_id"() RESTRICT;
--> statement-breakpoint
UPDATE "public"."agents"
   SET "enabled" = false, "updated_at" = now()
 WHERE "slug" = 'client-responder' AND "enabled";
