-- Workspaces, phase W5b1 fix round 2 (plan page 4887b8e7; the W5b1
-- re-audit, items M-new, L-a, L-b).
--
-- M-new: a fresh install is migrated at its first owner, before onboarding
-- makes its assistants, so Admin and Team had none. mantle_ws_attach_assistants()
-- attaches the same ones 0251 does at migrate time (the persona on Admin, the
-- team responder on Team), only where the workspace has no assistant yet and
-- the agent belongs to no workspace. Idempotent. Onboarding calls it after
-- the manifest seed, and the boot step after the migration.
--
-- L-a: an item another transaction inserts while mantle_ws_migrate runs is
-- not seen by it, and its own bridge trigger saw no workspaces: it ends with
-- no grants. mantle_ws_repair_drift() takes the heads of the drifting items
-- first (W1), then applies the bridge to exactly those. The app calls it
-- right after the migration commits, and on every boot of a migrated brain
-- (a no-op when there is no drift).
--
-- L-b: mantle_ws_migrate_locked waits at most 10 s for a lock; the boot step
-- logs a timeout and tries again at the next boot.
--
-- Functions only: no row written here, no LLM work, no extractor notify.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_migrate_locked"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp
  SET lock_timeout = '10s' AS $$
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_repair_drift"()
  RETURNS integer LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp
  SET lock_timeout = '10s' AS $$
DECLARE
  ids uuid[] := ARRAY(SELECT "public"."mantle_bridge_drift_ids"());
BEGIN
  IF cardinality(ids) = 0 THEN RETURN 0; END IF;
  PERFORM "public"."mantle_lock_heads"(ids, 'update');
  PERFORM "public"."mantle_bridge_apply"(ids);
  RETURN cardinality(ids);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_repair_drift"() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_attach_assistants"()
  RETURNS integer LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp
  SET lock_timeout = '10s' AS $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  admin_ws uuid;
  team_ws uuid;
  pick uuid;
  added integer := 0;
BEGIN
  IF brain IS NULL THEN RETURN 0; END IF;
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = brain AND w."bridge_key" = 'admin';
  SELECT w."id" INTO team_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = brain AND w."bridge_key" = 'team';
  IF admin_ws IS NULL THEN RETURN 0; END IF;
  -- The persona on Admin: the selection of 0251 (the enabled admin-level
  -- responder, highest priority, a shared one before a login's own).
  IF NOT EXISTS (SELECT 1 FROM "public"."workspace_resources" r
                  WHERE r."workspace_id" = admin_ws AND r."type" = 'assistant') THEN
    SELECT a."id" INTO pick FROM "public"."agents" a
     WHERE a."owner_id" = brain AND a."role" = 'responder' AND a."audience" = 'admin' AND a."enabled"
       AND a."workspace_id" IS NULL
     ORDER BY a."priority" DESC, a."assigned_user_id" IS NOT NULL, a."created_at"
     LIMIT 1;
    IF pick IS NOT NULL THEN
      INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
      VALUES (admin_ws, 'assistant', pick::text, true);
      added := added + 1;
    END IF;
  END IF;
  -- The team responder on Team.
  IF team_ws IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "public"."workspace_resources" r
        WHERE r."workspace_id" = team_ws AND r."type" = 'assistant') THEN
    pick := NULL;
    SELECT a."id" INTO pick FROM "public"."agents" a
     WHERE a."owner_id" = brain AND a."slug" = 'team-responder' AND a."audience" = 'team'
       AND a."workspace_id" IS NULL
     LIMIT 1;
    IF pick IS NOT NULL THEN
      INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
      VALUES (team_ws, 'assistant', pick::text, true);
      added := added + 1;
    END IF;
  END IF;
  RETURN added;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_attach_assistants"() FROM PUBLIC;
