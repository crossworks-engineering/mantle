-- Workspaces, phase W5b1 fix round 1 (plan page 4887b8e7; the W5b1 audit,
-- items M1 and L1).
--
-- M1: a fresh install is never migrated by 0252 (no owner yet when the
-- migrations run), so it ran on levels alone. mantle_ws_migrate_locked() is
-- the one entry the app calls: at the first owner's signup and as a boot
-- step. It skips, without a lock, a brain with no anchor, one already
-- migrated, and one with client logins or client-level items (owner rule
-- 21.9: clients are set up by hand; the integrity row stays). Otherwise it
-- takes the heads of every brain item first (W1: heads are the first lock),
-- then one advisory lock (two boots at once: the second finds it migrated),
-- then runs mantle_ws_migrate() and repairs any bridge drift, as 0252 did.
-- mantle_ws_skip_reason() says why a brain is not migrated (the integrity
-- row reads it).
--
-- L1: the bridge gave Team Write on a public app, though the member write
-- rule (memberMayWriteAppData) refuses public apps. Team Write on an app now
-- needs its level (own, or a folder share; never an embed) to be team or
-- client, and the data not read-only. Existing rows are corrected by 0258.
--
-- Functions only: no lock beyond the catalog, no row written, no LLM work,
-- no extractor notify.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- Whether the Team workspace may write an app's data: the member write rule
-- (memberMayWriteAppData over itemLevel), team or client, never public, and
-- not read-only. Embeds never count (old trap 2).
CREATE OR REPLACE FUNCTION "public"."mantle_app_team_writes"(
  t "public"."node_type", audience text, inherited text, read_only boolean)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t = 'app' AND NOT coalesce(read_only, false)
     AND coalesce(audience, '') <> 'public'
     AND (coalesce(audience IN ('team', 'client'), false)
          OR coalesce(inherited IN ('team', 'client'), false))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_wanted"(ids uuid[])
  RETURNS SETOF "public"."mantle_bridge_row"
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH ws AS (
    SELECT (SELECT w."id" FROM "public"."workspaces" w
             WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin') AS admin_ws,
           (SELECT w."id" FROM "public"."workspaces" w
             WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'team') AS team_ws
  ), n AS (
    SELECT x."id", "public"."mantle_kind_class"(x."type") AS kc, x."type" = 'app' AS is_app,
           "public"."mantle_team_reads"(x."type", x."audience", x."inherited_level",
             CASE WHEN x."type" = 'app' THEN NULL ELSE x."embedded_level" END) AS team,
           "public"."mantle_app_team_writes"(x."type", x."audience", x."inherited_level",
             coalesce(a."data_read_only", false)) AS app_write
      FROM "public"."nodes" x
      LEFT JOIN "public"."apps" a ON a."node_id" = x."id"
     WHERE x."id" = ANY (ids)
       AND x."owner_id" = "public"."mantle_brain_id"()
       AND NOT EXISTS (SELECT 1 FROM "public"."item_grants" h
                        WHERE h."node_id" = x."id" AND h."is_home" AND NOT h."bridge")
  )
  -- Admin: the home, except for an app the team reads ("removed here").
  SELECT n."id", ws.admin_ws, false, NOT (n.is_app AND n.team), n.is_app AND n.team
    FROM n, ws WHERE ws.admin_ws IS NOT NULL
  UNION ALL
  -- Team: for the workspace kinds only.
  SELECT n."id", ws.team_ws,
         n.team AND n.is_app AND n.app_write,
         n.team AND n.is_app,
         NOT n.team
    FROM n, ws
   WHERE ws.admin_ws IS NOT NULL AND ws.team_ws IS NOT NULL AND n.kc = 'workspace'
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_wanted"(uuid[]) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_before_ins_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  a uuid;
  t uuid;
  team boolean;
BEGIN
  SELECT w."id" INTO a FROM "public"."workspaces" w
   WHERE w."owner_id" = NEW."owner_id" AND w."bridge_key" = 'admin';
  IF a IS NULL OR NEW."owner_id" IS DISTINCT FROM "public"."mantle_brain_id"() THEN RETURN NEW; END IF;
  SELECT w."id" INTO t FROM "public"."workspaces" w
   WHERE w."owner_id" = NEW."owner_id" AND w."bridge_key" = 'team';
  team := t IS NOT NULL AND "public"."mantle_kind_class"(NEW."type") = 'workspace'
          AND "public"."mantle_team_reads"(NEW."type", NEW."audience", NEW."inherited_level",
                CASE WHEN NEW."type" = 'app' THEN NULL ELSE NEW."embedded_level" END);
  IF NEW."type" = 'app' AND team THEN
    -- T1; a new app has no apps row yet, so its data is writable at team or
    -- client, never public (the apps trigger corrects Write when the row
    -- comes).
    NEW."home_ws" := t;
    NEW."read_ws" := ARRAY[t];
    NEW."write_ws" := CASE WHEN "public"."mantle_app_team_writes"(NEW."type", NEW."audience",
                             NEW."inherited_level", false)
                           THEN ARRAY[t] ELSE '{}'::uuid[] END;
  ELSE
    NEW."home_ws" := a;
    NEW."read_ws" := CASE WHEN team THEN ARRAY(SELECT x FROM unnest(ARRAY[a, t]) x ORDER BY x)
                          ELSE ARRAY[a] END;
    NEW."write_ws" := '{}'::uuid[];
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_before_ins_trg"() FROM PUBLIC;
--> statement-breakpoint

-- Why this brain has no workspaces, or NULL when it has them.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_skip_reason"()
  RETURNS text LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  clients bigint;
  client_items bigint;
BEGIN
  IF brain IS NULL THEN RETURN 'no brain anchor yet'; END IF;
  IF EXISTS (SELECT 1 FROM "public"."workspaces" w
              WHERE w."owner_id" = brain AND w."bridge_key" = 'admin') THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO clients FROM auth.users u WHERE u."role" = 'client';
  SELECT count(*) INTO client_items FROM "public"."nodes" n
   WHERE n."owner_id" = brain
     AND (n."audience" = 'client' OR n."inherited_level" = 'client' OR n."embedded_level" = 'client');
  IF clients > 0 OR client_items > 0 THEN
    RETURN format('clients present: %s client login(s), %s client-level item(s)', clients, client_items);
  END IF;
  RETURN 'no workspaces yet';
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_skip_reason"() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_migrate_locked"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  why text := "public"."mantle_ws_skip_reason"();
BEGIN
  IF why IS NULL THEN
    RETURN QUERY SELECT 'skip'::text, 'workspaces'::text, 'already migrated'::text, 1::bigint;
    RETURN;
  END IF;
  IF why <> 'no workspaces yet' THEN
    RETURN QUERY SELECT 'skip'::text, why, 'count'::text, 1::bigint;
    RETURN;
  END IF;
  PERFORM "public"."mantle_lock_heads"(ARRAY(
    SELECT x."id" FROM "public"."nodes" x WHERE x."owner_id" = "public"."mantle_brain_id"()), 'update');
  PERFORM pg_advisory_xact_lock(hashtext('mantle_ws_migrate'));
  RETURN QUERY SELECT * FROM "public"."mantle_ws_migrate"();
  PERFORM "public"."mantle_bridge_apply"(ARRAY(SELECT "public"."mantle_bridge_drift_ids"()));
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate_locked"() FROM PUBLIC;
