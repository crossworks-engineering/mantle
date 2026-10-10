-- Workspaces W5b2 part B: grants are the truth (plan page 4887b8e7, sections
-- 9.5, 11 W5b, 18 S2 and S6, 21.8 rows 1 and 7; HANDOVER 6 of task 5070a886).
--
-- 1. The tier levels are archived and frozen: archive_node_levels keeps each
--    node's audience, share_level, inherited_level and embedded_level as they
--    were at the switch (for W8); the columns stay, read only. A change is
--    refused unless a named migration bypass is on (mantle_heads_bypass).
-- 2. The bridge is off: the triggers that turned levels into grants
--    (nodes, apps, connectors, logins) and the level upkeep triggers (folder
--    share inheritance, embed reach) are dropped. Their functions stay (the
--    reach proof and the one-time migration of a fresh brain still use them).
--    node_embeds keeps its rows (the Grant Access panel and the share pages
--    read them).
-- 3. The bridge's rows become plain grants, after three narrowing-only fixes
--    (no login reads more; the reach proof checks it):
--    a. a folder whose Team row came from its own level, not a folder share,
--       would pass Team to every new item placed in it (S6): that row goes;
--    b. an item whose Team row came only from its folder's share becomes a
--       row derived from that folder, so a later folder change reaches it;
--    c. a bridge "Removed here" row whose folder does not grant that
--       workspace means nothing and would block a later folder grant: it goes;
--    d. a public app's Team row has Write off (members never wrote the data
--       of a public app; W5b1 flag).
-- 4. A new item gets a HOME (before, only the bridge wrote homes): the home
--    of the folder it is made in, else Admin; kinds that live in Admin only,
--    Admin (21.8 row 7, R7). It also takes its folder's rows (S6). An item
--    re-owned into the brain (an accepted member item) gets the same home
--    when it has none.
-- 5. A fresh brain migrated later (lib/workspaces-migrate.ts) ends with the
--    same plain rows: mantle_ws_migrate runs the steps of 3 after its bridge
--    pass. The boot drift repair has nothing left to repair.
--
-- No LLM work, no extractor notify. Narrowing only.

SELECT "public"."mantle_heads_bypass"('0261_workspaces_bridge_off');
--> statement-breakpoint

-- ── 1. Archive and freeze ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."archive_node_levels" AS
  SELECT n."id" AS "node_id", n."owner_id", n."audience", n."share_level",
         n."inherited_level", n."embedded_level", now() AS "archived_at"
    FROM "public"."nodes" n;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'archive_node_levels_pkey') THEN
    ALTER TABLE "public"."archive_node_levels" ADD PRIMARY KEY ("node_id");
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "public"."archive_node_levels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "public"."archive_node_levels" FROM PUBLIC;
--> statement-breakpoint

-- Whether a verified named migration bypass is on in this transaction.
CREATE OR REPLACE FUNCTION "public"."mantle_heads_bypass_on"()
  RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  bypass text := coalesce(current_setting('mantle.heads_bypass', true), '');
BEGIN
  IF bypass = '' OR position('|' IN bypass) = 0 THEN RETURN false; END IF;
  RETURN split_part(bypass, '|', 2)
         = "public"."mantle_heads_mac"('bypass:' || split_part(bypass, '|', 1));
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_heads_bypass_on"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_levels_frozen_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF (OLD."audience", OLD."share_level", OLD."inherited_level", OLD."embedded_level")
     IS DISTINCT FROM (NEW."audience", NEW."share_level", NEW."inherited_level", NEW."embedded_level")
     AND NOT "public"."mantle_heads_bypass_on"() THEN
    RAISE EXCEPTION 'the sharing levels are frozen: grants decide access (workspaces W5b2)'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_levels_frozen_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_levels_frozen" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_levels_frozen"
  BEFORE UPDATE OF "audience", "share_level", "inherited_level", "embedded_level"
  ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_levels_frozen_trg"();
--> statement-breakpoint

-- ── 2. The bridge and the level upkeep, off ──────────────────────────────────

DROP TRIGGER IF EXISTS "nodes_zz_bridge_before" ON "public"."nodes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_zz_bridge_ins" ON "public"."nodes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_zz_bridge_upd" ON "public"."nodes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_zz_bridge_upd_stmt" ON "public"."nodes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "apps_zz_bridge" ON "public"."apps";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "apps_zz_bridge_ins" ON "public"."apps";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "tool_groups_zz_bridge" ON "public"."tool_groups";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_zz_bridge" ON auth.users;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_inherit_before" ON "public"."nodes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_share_refresh_after" ON "public"."nodes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_share_deleted_after" ON "public"."nodes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_embed_reach_after" ON "public"."nodes";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "node_embeds_added_after" ON "public"."node_embeds";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "node_embeds_removed_after" ON "public"."node_embeds";
--> statement-breakpoint

-- ── 3. The bridge's rows become plain grants ─────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."mantle_ws_bridge_off"()
  RETURNS TABLE ("step" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  team_ws uuid;
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
  c bigint;
BEGIN
  IF brain IS NULL OR NOT EXISTS (SELECT 1 FROM "public"."item_grants" g WHERE g."bridge") THEN
    RETURN;
  END IF;
  SELECT w."id" INTO team_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = brain AND w."bridge_key" = 'team';
  PERFORM set_config('mantle.acl_internal', 'on', true);

  IF team_ws IS NOT NULL THEN
    -- a. A folder that holds Team by its own level only (no folder share
    --    reaches it, and it shares nothing): its Team row goes.
    DELETE FROM "public"."item_grants" g
     USING "public"."nodes" f
     WHERE g."node_id" = f."id" AND f."owner_id" = brain AND f."type" = 'branch'
       AND g."workspace_id" = team_ws AND g."bridge"
       AND NOT g."is_home" AND NOT g."excluded" AND g."via_folder_id" IS NULL
       AND NOT coalesce(f."share_level"::text IN ('team', 'client'), false)
       AND NOT coalesce(f."inherited_level"::text IN ('team', 'client'), false);
    GET DIAGNOSTICS c = ROW_COUNT;
    RETURN QUERY SELECT 'folder team rows by own level, removed', c;

    -- b. A Team row that only the folder's share gave: derived from that
    --    folder from now on.
    UPDATE "public"."item_grants" g
       SET "via_folder_id" = f."id", "write" = fg."write"
      FROM "public"."nodes" n, "public"."nodes" f, "public"."item_grants" fg
     WHERE g."node_id" = n."id" AND n."owner_id" = brain
       AND g."workspace_id" = team_ws AND g."bridge"
       AND NOT g."is_home" AND NOT g."excluded" AND g."via_folder_id" IS NULL
       AND coalesce(n."inherited_level"::text IN ('team', 'client'), false)
       AND NOT coalesce(n."audience"::text IN ('team', 'client', 'public'), false)
       AND NOT coalesce(n."type" <> 'app' AND n."embedded_level"::text IN ('team', 'client', 'public'), false)
       AND f."id" = "public"."mantle_parent_folder"(n."owner_id", n."type", n."path")
       AND fg."node_id" = f."id" AND fg."workspace_id" = team_ws AND NOT fg."excluded"
       AND "public"."mantle_grant_kind_ok"(n."type", team_ws, true);
    GET DIAGNOSTICS c = ROW_COUNT;
    RETURN QUERY SELECT 'team rows from a folder share, now derived', c;

    -- d. Members never wrote the data of a public app.
    UPDATE "public"."item_grants" g SET "write" = false
      FROM "public"."nodes" n
     WHERE g."node_id" = n."id" AND n."type" = 'app' AND g."bridge" AND g."write"
       AND g."workspace_id" = team_ws
       AND (n."audience"::text = 'public' OR coalesce(n."inherited_level"::text = 'public', false));
    GET DIAGNOSTICS c = ROW_COUNT;
    RETURN QUERY SELECT 'public app team rows, write off', c;
  END IF;

  -- c. "Removed here" where the folder does not grant that workspace.
  DELETE FROM "public"."item_grants" g
   USING "public"."nodes" n
   WHERE g."node_id" = n."id" AND g."bridge" AND g."excluded"
     AND NOT EXISTS (
       SELECT 1 FROM "public"."item_grants" fg
        WHERE fg."node_id" = "public"."mantle_parent_folder"(n."owner_id", n."type", n."path")
          AND fg."workspace_id" = g."workspace_id" AND NOT fg."excluded");
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'removed-here rows with no folder grant, deleted', c;

  UPDATE "public"."item_grants" SET "bridge" = false WHERE "bridge";
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'bridge rows, now plain grants', c;
  PERFORM set_config('mantle.acl_internal', was, true);
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_bridge_off"() FROM PUBLIC;
--> statement-breakpoint
SELECT * FROM "public"."mantle_ws_bridge_off"();
--> statement-breakpoint

-- A fresh brain migrated after this point: the 0251 pass, then the same.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'mantle_ws_migrate_bridged') THEN
    ALTER FUNCTION "public"."mantle_ws_migrate"() RENAME TO "mantle_ws_migrate_bridged";
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_migrate"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY SELECT * FROM "public"."mantle_ws_migrate_bridged"();
  RETURN QUERY SELECT 'bridge off'::text, b."step", 'count'::text, b."n"
                 FROM "public"."mantle_ws_bridge_off"() b;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate"() FROM PUBLIC;
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
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate_locked"() FROM PUBLIC;
--> statement-breakpoint
-- No bridge, no drift to repair (workspaces:check reports grant drift).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_repair_drift"()
  RETURNS integer LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT 0
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_repair_drift"() FROM PUBLIC;
--> statement-breakpoint

-- ── 4. A new item's home ─────────────────────────────────────────────────────

-- The home a brain item takes when nothing names one: Admin for a kind that
-- lives in Admin only (and a conversation kind), else the home of the folder
-- it sits in when that kind may live there, else Admin. NULL for a personal
-- item and on a brain with no workspaces.
CREATE OR REPLACE FUNCTION "public"."mantle_default_home"(
  o uuid, t "public"."node_type", p ltree)
  RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  admin_ws uuid;
  home uuid;
BEGIN
  IF o IS NULL OR o IS DISTINCT FROM "public"."mantle_brain_id"() THEN RETURN NULL; END IF;
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = o AND w."is_admin" LIMIT 1;
  IF admin_ws IS NULL THEN RETURN NULL; END IF;
  IF "public"."mantle_kind_class"(t) <> 'workspace' THEN RETURN admin_ws; END IF;
  SELECT f."home_ws" INTO home FROM "public"."nodes" f
   WHERE f."id" = "public"."mantle_parent_folder"(o, t, p);
  IF home IS NOT NULL
     AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."id" = home AND w."archived_at" IS NULL)
     AND "public"."mantle_grant_kind_ok"(t, home) THEN
    RETURN home;
  END IF;
  RETURN admin_ws;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_default_home"(uuid, "public"."node_type", ltree) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_before_ins_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  f uuid;
  home uuid;
BEGIN
  f := "public"."mantle_parent_folder"(NEW."owner_id", NEW."type", NEW."path");
  IF f IS NOT NULL THEN
    PERFORM "public"."mantle_heads_require"(ARRAY[f], 'nodes_insert');
    SELECT coalesce(array_agg(g."workspace_id" ORDER BY g."workspace_id"), '{}'::uuid[]),
           coalesce(array_agg(g."workspace_id" ORDER BY g."workspace_id") FILTER (WHERE g."write"), '{}'::uuid[])
      INTO NEW."read_ws", NEW."write_ws"
      FROM "public"."item_grants" g
     WHERE g."node_id" = f AND NOT g."excluded"
       AND "public"."mantle_grant_kind_ok"(NEW."type", g."workspace_id", true);
  ELSE
    NEW."read_ws" := '{}'::uuid[];
    NEW."write_ws" := '{}'::uuid[];
  END IF;
  -- The home (written as a row by the AFTER trigger). Its row has Write
  -- off, so a folder row for the same workspace gives way to it.
  home := "public"."mantle_default_home"(NEW."owner_id", NEW."type", NEW."path");
  NEW."home_ws" := home;
  IF home IS NOT NULL THEN
    NEW."read_ws" := ARRAY(SELECT DISTINCT x FROM unnest(NEW."read_ws" || home) x ORDER BY x);
    NEW."write_ws" := array_remove(NEW."write_ws", home);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_acl_after_ins_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
  held uuid[];
BEGIN
  INSERT INTO "public"."node_acl_head" ("node_id") VALUES (NEW."id")
    ON CONFLICT DO NOTHING;
  -- A folder this transaction made is its own (0244 rule 4).
  IF NEW."type" = 'branch' THEN
    held := "public"."mantle_heads_held"();
    IF cardinality(held) > 0 THEN
      PERFORM "public"."mantle_heads_set"(held || NEW."id",
                                           "public"."mantle_heads_held"(true) || NEW."id");
    END IF;
  END IF;
  IF NEW."home_ws" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "public"."nodes" f
      JOIN "public"."item_grants" g ON g."node_id" = f."id"
     WHERE f."owner_id" = NEW."owner_id" AND f."type" = 'branch'
       AND f."path" = "public"."mantle_parent_folder_path"(NEW."type", NEW."path")) THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('mantle.acl_internal', 'on', true);
  IF NEW."home_ws" IS NOT NULL THEN
    INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "is_home")
    VALUES (NEW."id", NEW."home_ws", false, true)
    ON CONFLICT DO NOTHING;
  END IF;
  -- Placing is accepting (S6): the folder's rows, its home's included.
  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "via_folder_id")
  SELECT NEW."id", g."workspace_id", g."write", f."id"
    FROM "public"."nodes" f
    JOIN "public"."item_grants" g ON g."node_id" = f."id" AND NOT g."excluded"
   WHERE f."owner_id" = NEW."owner_id" AND f."type" = 'branch'
     AND f."path" = "public"."mantle_parent_folder_path"(NEW."type", NEW."path")
     AND "public"."mantle_grant_kind_ok"(NEW."type", g."workspace_id", true)
  ON CONFLICT DO NOTHING;
  PERFORM set_config('mantle.acl_internal', was, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- An item re-owned into the brain (a member's item accepted) with no home
-- yet: the same default home (its folder's rows follow from the move
-- triggers of 0244).
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_reown_home_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  was text := coalesce(current_setting('mantle.acl_internal', true), '');
  home uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."item_grants" g WHERE g."node_id" = NEW."id" AND g."is_home") THEN
    RETURN NULL;
  END IF;
  home := "public"."mantle_default_home"(NEW."owner_id", NEW."type", NEW."path");
  IF home IS NULL THEN RETURN NULL; END IF;
  PERFORM set_config('mantle.acl_internal', 'on', true);
  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "is_home")
  VALUES (NEW."id", home, false, true)
  ON CONFLICT ("node_id", "workspace_id") DO UPDATE
     SET "is_home" = true, "via_folder_id" = NULL, "excluded" = false, "write" = false;
  PERFORM set_config('mantle.acl_internal', was, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_reown_home_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_acl_reown_home" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_acl_reown_home" AFTER UPDATE OF "owner_id" ON "public"."nodes"
  FOR EACH ROW WHEN (OLD."owner_id" IS DISTINCT FROM NEW."owner_id")
  EXECUTE FUNCTION "public"."mantle_nodes_reown_home_trg"();
