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
-- 3. The bridge's rows become plain grants, after one accepted widening and
--    narrowing-only fixes (no login reads more items; the reach proof checks
--    it):
--    a0. a folder shared with the team or clients by its share level holds a
--       Team row (Write off), so it passes Team on to what is placed in it
--       later; members read the folder's title (accepted, CEO call
--       2026-10-11; the reach diff counts such a folder as read today);
--    a. a folder whose Team row came from its own level, not a folder share,
--       would pass Team to every new item placed in it (S6): that row goes;
--    b. an item whose Team row came only from its folder's share becomes a
--       row derived from that folder, so a later folder change reaches it;
--    c. a bridge "Removed here" row whose folder does not grant that
--       workspace means nothing and would block a later folder grant: it goes;
--    d. a public app's Team row has Write off (members never wrote the data
--       of a public app; W5b1 flag);
--    e. an informational app (apps.data_read_only) has Write off on every
--       grant beyond Admin: the grant's Write switch alone decides member
--       writes from now on (owner call, 2026-10-11).
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

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SELECT "public"."mantle_heads_bypass"('0261_workspaces_bridge_off');
--> statement-breakpoint

-- ── 1. Archive and freeze ────────────────────────────────────────────────────

-- The table only: its rows are written when the brain switches
-- (mantle_ws_switch_off below), so a brain that is not switched here keeps
-- no stale copy and one switched later archives the levels it had then.
CREATE TABLE IF NOT EXISTS "public"."archive_node_levels" AS
  SELECT n."id" AS "node_id", n."owner_id", n."audience", n."share_level",
         n."inherited_level", n."embedded_level", now() AS "archived_at"
    FROM "public"."nodes" n
  WITH NO DATA;
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
-- DDL on busy tables, retried (L-db): every statement in one subtransaction
-- under the migration's 5 s lock_timeout; when a lock is busy the attempt
-- rolls back to its savepoint (releasing what it took), waits and tries
-- again, up to 12 times, then fails the migration (safe to run again).
CREATE OR REPLACE FUNCTION "public"."mantle_ws_ddl_retry"(stmts text[], what text)
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  attempt int := 0;
  st text;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      FOREACH st IN ARRAY stmts LOOP
        EXECUTE st;
      END LOOP;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= 12 THEN
        RAISE EXCEPTION '%: the tables stayed busy for 12 attempts; run the migration again at a quieter time', what
          USING ERRCODE = 'lock_not_available';
      END IF;
      RAISE NOTICE '%: tables busy (attempt %), retrying', what, attempt;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_ddl_retry"(text[], text) FROM PUBLIC;
--> statement-breakpoint

-- ── 2. The switch: archive, freeze, the bridge and the level upkeep off ──────

-- Run once a brain is on workspaces (here, or by mantle_ws_migrate for a
-- brain migrated later): its levels are archived and frozen, and the
-- triggers that turned levels into grants (nodes, apps, connectors, logins)
-- and kept the levels (folder share inheritance, embed reach) are dropped.
-- Their functions stay. A brain that is NOT on workspaces (client logins or
-- client-level items, owner rule 21.9) never gets here: it keeps its levels
-- and its bridge.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_switch_off"()
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
BEGIN
  INSERT INTO "public"."archive_node_levels"
         ("node_id", "owner_id", "audience", "share_level", "inherited_level", "embedded_level", "archived_at")
  SELECT n."id", n."owner_id", n."audience", n."share_level", n."inherited_level", n."embedded_level", now()
    FROM "public"."nodes" n
  ON CONFLICT ("node_id") DO NOTHING;
  PERFORM "public"."mantle_ws_ddl_retry"(ARRAY[
    'DROP TRIGGER IF EXISTS "nodes_zz_bridge_before" ON "public"."nodes"',
    'DROP TRIGGER IF EXISTS "nodes_zz_bridge_ins" ON "public"."nodes"',
    'DROP TRIGGER IF EXISTS "nodes_zz_bridge_upd" ON "public"."nodes"',
    'DROP TRIGGER IF EXISTS "nodes_zz_bridge_upd_stmt" ON "public"."nodes"',
    'DROP TRIGGER IF EXISTS "apps_zz_bridge" ON "public"."apps"',
    'DROP TRIGGER IF EXISTS "apps_zz_bridge_ins" ON "public"."apps"',
    'DROP TRIGGER IF EXISTS "tool_groups_zz_bridge" ON "public"."tool_groups"',
    'DROP TRIGGER IF EXISTS "users_zz_bridge" ON auth.users',
    'DROP TRIGGER IF EXISTS "nodes_inherit_before" ON "public"."nodes"',
    'DROP TRIGGER IF EXISTS "nodes_share_refresh_after" ON "public"."nodes"',
    'DROP TRIGGER IF EXISTS "nodes_share_deleted_after" ON "public"."nodes"',
    'DROP TRIGGER IF EXISTS "nodes_embed_reach_after" ON "public"."nodes"',
    'DROP TRIGGER IF EXISTS "node_embeds_added_after" ON "public"."node_embeds"',
    'DROP TRIGGER IF EXISTS "node_embeds_removed_after" ON "public"."node_embeds"',
    'DROP TRIGGER IF EXISTS "nodes_levels_frozen" ON "public"."nodes"',
    'CREATE TRIGGER "nodes_levels_frozen"
       BEFORE UPDATE OF "audience", "share_level", "inherited_level", "embedded_level"
       ON "public"."nodes"
       FOR EACH ROW EXECUTE FUNCTION "public"."mantle_levels_frozen_trg"()'
  ], 'the workspaces switch');
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_switch_off"() FROM PUBLIC;
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
  -- What every workspace beyond Admin may write before the steps below:
  -- the switch guard (mantle_ws_switch_guard) proves nothing was gained.
  CREATE TEMP TABLE IF NOT EXISTS "ws_switch_writes_before" ("node_id" uuid, "workspace_id" uuid)
    ON COMMIT DROP;
  TRUNCATE "ws_switch_writes_before";
  INSERT INTO "ws_switch_writes_before"
  SELECT n."id", x FROM "public"."nodes" n
   CROSS JOIN LATERAL unnest(n."write_ws") x
   JOIN "public"."workspaces" w ON w."id" = x AND NOT w."is_admin"
   WHERE n."owner_id" = brain;
  PERFORM set_config('mantle.acl_internal', 'on', true);

  IF team_ws IS NOT NULL THEN
    -- a0. A folder shared with the team or with clients by its share level
    --     IS the share: it holds a Team row of its own (Write off), so what
    --     is placed in it after the switch still reaches Team (the bridge
    --     marked such a folder "Removed here" when its own level was Admin,
    --     and step c would delete that row). The one widening of the switch,
    --     accepted (CEO call, 2026-10-11): members read the folder node
    --     itself, its title, which they already browse into. The reach diff
    --     counts these folders as read by Team today.
    INSERT INTO "public"."item_grants" AS g
           ("node_id", "workspace_id", "write", "is_home", "excluded", "via_folder_id", "bridge")
    SELECT f."id", team_ws, false, false, false, NULL, true
      FROM "public"."nodes" f
     WHERE f."owner_id" = brain AND f."type" = 'branch'
       AND f."share_level"::text IN ('team', 'client')
    ON CONFLICT ("node_id", "workspace_id") DO UPDATE
       SET "excluded" = false, "write" = false, "via_folder_id" = NULL, "bridge" = true
     WHERE g."excluded";
    GET DIAGNOSTICS c = ROW_COUNT;
    RETURN QUERY SELECT 'shared folders, team row given', c;

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
    --    folder from now on. Its Write can only narrow: on only when both
    --    the row and the folder's row have it (M1).
    UPDATE "public"."item_grants" g
       SET "via_folder_id" = f."id", "write" = g."write" AND fg."write"
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

  -- e. An informational app (apps.data_read_only): from now on the grant's
  --    Write switch alone decides whether a workspace's users write its
  --    data (owner call, 2026-10-11), so every grant of such an app beyond
  --    Admin has Write off. Nobody gains a write.
  UPDATE "public"."item_grants" g SET "write" = false
    FROM "public"."apps" a, "public"."workspaces" w
   WHERE g."node_id" = a."node_id" AND a."data_read_only" AND g."write"
     AND w."id" = g."workspace_id" AND NOT w."is_admin" AND w."owner_id" = brain;
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'informational app rows beyond Admin, write off', c;

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
-- The reach diff (0251) counts a folder shared with the team or clients by
-- its share level as read by Team today: step a0 above gives it its Team row.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_reach_diff"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH b AS (SELECT "public"."mantle_brain_id"() AS brain),
  ws AS (
    SELECT (SELECT w."id" FROM "public"."workspaces" w, b WHERE w."owner_id" = b.brain AND w."bridge_key" = 'admin') AS admin_ws,
           (SELECT w."id" FROM "public"."workspaces" w, b WHERE w."owner_id" = b.brain AND w."bridge_key" = 'team') AS team_ws
  ),
  team_today AS (
    SELECT n."id" FROM "public"."nodes" n, b
     WHERE n."owner_id" = b.brain
       AND (n."audience" = ANY (ARRAY['team', 'client', 'public'])
            OR n."inherited_level" = ANY (ARRAY['team', 'client', 'public'])
            OR n."embedded_level" = ANY (ARRAY['team', 'client', 'public']))
       AND "public"."mantle_workspace_kind"(n."type")
    UNION
    -- A folder shared with the team or clients by its share level: Team
    -- holds it since 0261 (its title, the accepted widening).
    SELECT n."id" FROM "public"."nodes" n, b
     WHERE n."owner_id" = b.brain AND n."type" = 'branch'
       AND n."share_level" = ANY (ARRAY['team', 'client'])
  ),
  old_reach AS (
    SELECT 'login:' || u."id" AS subject, n."id" AS node_id
      FROM auth.users u JOIN "public"."nodes" n ON n."owner_id" = (SELECT brain FROM b)
     WHERE u."role" = 'admin'
    UNION
    SELECT 'login:' || u."id", t."id" FROM auth.users u, team_today t WHERE u."role" = 'member'
    UNION
    SELECT 'assistant:admin', n."id" FROM "public"."nodes" n WHERE n."owner_id" = (SELECT brain FROM b)
    UNION
    SELECT 'assistant:team', t."id" FROM team_today t
  ),
  new_reach AS (
    SELECT 'login:' || wu."login_id" AS subject, n."id" AS node_id
      FROM "public"."workspace_users" wu
      JOIN "public"."nodes" n ON n."owner_id" = (SELECT brain FROM b) AND n."read_ws" @> ARRAY[wu."workspace_id"]
    UNION
    SELECT 'assistant:admin', n."id" FROM "public"."nodes" n, ws
     WHERE n."owner_id" = (SELECT brain FROM b) AND n."read_ws" @> ARRAY[ws.admin_ws]
    UNION
    SELECT 'assistant:team', n."id" FROM "public"."nodes" n, ws
     WHERE n."owner_id" = (SELECT brain FROM b) AND n."read_ws" @> ARRAY[ws.team_ws]
  ),
  conn AS (
    SELECT g."slug",
           (g."integration" ? 'mcp' AND g."enabled" AND g."audience" IN ('team', 'client', 'public')) AS member_today,
           r."id" IS NOT NULL AS held, coalesce(r."write", false) AS team_write
      FROM "public"."tool_groups" g
      CROSS JOIN ws
      LEFT JOIN "public"."workspace_resources" r
        ON r."workspace_id" = ws.team_ws AND r."type" = 'connector' AND r."ref_id" = g."slug"
     WHERE g."owner_id" = (SELECT brain FROM b) AND g."integration" IS NOT NULL
  ),
  gained AS (
    SELECT nw.subject, nw.node_id FROM new_reach nw
     WHERE NOT EXISTS (SELECT 1 FROM old_reach o WHERE o.subject = nw.subject AND o.node_id = nw.node_id)
  )
  SELECT 'reach-fail', CASE WHEN g.subject LIKE 'login:%'
                            THEN 'login (' || coalesce(u."role", 'gone') || ')' ELSE g.subject END,
         'gained items', count(*)
    FROM gained g
    LEFT JOIN auth.users u ON 'login:' || u."id" = g.subject
   GROUP BY 2
  UNION ALL
  -- Chunks and windows follow their item (their row rule reads the node,
  -- 0249): the passages of a gained item are gained with it.
  SELECT 'reach-fail', 'chunks', 'of gained items', count(*)
    FROM gained g JOIN "public"."content_chunks" c ON c."node_id" = g.node_id
  HAVING count(*) > 0
  UNION ALL
  -- Facts keep their own copy of the reading workspaces (R7). A fact may be
  -- read by a workspace beyond Admin only when its source item is (then the
  -- items' proof above covers it); a fact with no source only in Admin. A
  -- mixed fact is read only by a scope holding Admin (0247), which read
  -- everything before; a fact stamped with a login is read by that login
  -- alone (its own chat, S4).
  SELECT 'reach-fail', 'facts', 'read wider than their source item', count(*)
    FROM "public"."facts" f
   WHERE f."owner_id" = (SELECT brain FROM b) AND NOT f."derived_mixed" AND f."login_id" IS NULL
     AND EXISTS (
       SELECT 1 FROM unnest(f."read_ws") x
         JOIN "public"."workspaces" w ON w."id" = x AND NOT w."is_admin"
        WHERE f."source_node_id" IS NULL
           OR NOT EXISTS (SELECT 1 FROM "public"."nodes" n
                           WHERE n."id" = f."source_node_id" AND n."read_ws" @> ARRAY[x]))
  HAVING count(*) > 0
  UNION ALL
  SELECT 'reach', CASE WHEN o.subject LIKE 'login:%'
                       THEN 'login (' || coalesce(u."role", 'gone') || ')' ELSE o.subject END,
         'lost items (narrower, allowed)', count(*)
    FROM old_reach o
    LEFT JOIN auth.users u ON 'login:' || u."id" = o.subject
   WHERE NOT EXISTS (SELECT 1 FROM new_reach nw WHERE nw.subject = o.subject AND nw.node_id = o.node_id)
   GROUP BY 2
  UNION ALL
  SELECT 'reach', split_part(s.subject, ':', 1), 'subjects', count(*)
    FROM (SELECT DISTINCT subject FROM new_reach) s GROUP BY 2
  UNION ALL
  SELECT 'reach-fail', 'connectors on Team', 'differ from what members may use today', count(*)
    FROM conn c
   WHERE c.member_today <> c.held OR (c.held AND c.team_write <> c.member_today)
  HAVING count(*) > 0
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_reach_diff"() FROM PUBLIC;
--> statement-breakpoint
-- Links (8.1): a live open link serves its item plus its served list; under
-- the levels it served its item plus items read at the public level, never
-- more. A served id that is not the item and not an item of the link's
-- owner read at the public level is a gained serve. Numbers only.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_links_diff"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH live AS (
    SELECT s."id", s."owner_id", s."node_id", s."settings"
      FROM "public"."shares" s
     WHERE s."revoked_at" IS NULL AND s."contact_id" IS NULL
       AND (s."expires_at" IS NULL OR s."expires_at" > now())
       AND coalesce(s."settings"->>'mode', 'public') <> 'team'
  ),
  served AS (
    SELECT l."id" AS share_id, l."owner_id", l."node_id", lower(v) AS served_id
      FROM live l
     CROSS JOIN LATERAL jsonb_array_elements_text(
       CASE WHEN jsonb_typeof(l."settings"->'served') = 'array' THEN l."settings"->'served'
            ELSE '[]'::jsonb END) v
  )
  SELECT 'reach-fail', 'links', 'serve an item not served before', count(*)
    FROM served x
   WHERE x.served_id <> lower(x."node_id"::text)
     AND NOT EXISTS (
       SELECT 1 FROM "public"."nodes" n
        WHERE n."id"::text = x.served_id AND n."owner_id" = x."owner_id"
          AND (n."audience"::text = 'public' OR coalesce(n."inherited_level"::text = 'public', false)
               OR coalesce(n."embedded_level"::text = 'public', false)))
  HAVING count(*) > 0
  UNION ALL
  SELECT 'reach', 'links', 'live open links', count(*) FROM live
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_links_diff"() FROM PUBLIC;
--> statement-breakpoint

-- The switch guard (plan 9.4, M1 and M2): the whole proof, on every box,
-- inside the transaction that switches it. Reads (items, their chunks,
-- facts) and connectors from mantle_ws_reach_diff; writes against what
-- every workspace beyond Admin could write before mantle_ws_bridge_off ran
-- in this transaction (when it ran: it records that first); links from
-- mantle_ws_links_diff. Any 'reach-fail' row raises 23514 and the whole
-- transaction (the migration, or mantle_ws_migrate) rolls back: nothing is
-- written. Otherwise it returns the rows.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_switch_guard"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  fails bigint;
  gained_writes bigint := 0;
  what text;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS "ws_switch_proof"
    ("section" text, "subject" text, "metric" text, "n" bigint) ON COMMIT DROP;
  TRUNCATE "ws_switch_proof";
  INSERT INTO "ws_switch_proof" SELECT * FROM "public"."mantle_ws_reach_diff"();
  INSERT INTO "ws_switch_proof" SELECT * FROM "public"."mantle_ws_links_diff"();
  IF to_regclass('pg_temp.ws_switch_writes_before') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FROM "public"."nodes" n
       CROSS JOIN LATERAL unnest(n."write_ws") x
       JOIN "public"."workspaces" w ON w."id" = x AND NOT w."is_admin"
       WHERE n."owner_id" = "public"."mantle_brain_id"()
         AND NOT EXISTS (SELECT 1 FROM pg_temp."ws_switch_writes_before" b
                          WHERE b."node_id" = n."id" AND b."workspace_id" = x)$q$
      INTO gained_writes;
    INSERT INTO "ws_switch_proof"
    SELECT CASE WHEN gained_writes > 0 THEN 'reach-fail' ELSE 'reach' END,
           'writes', 'gained by a workspace beyond Admin', gained_writes;
  END IF;
  SELECT coalesce(sum(p."n"), 0), string_agg(DISTINCT p."subject" || ' ' || p."metric", '; ')
    INTO fails, what
    FROM "ws_switch_proof" p WHERE p."section" = 'reach-fail';
  IF fails > 0 THEN
    RAISE EXCEPTION 'workspaces switch: % gained read(s), write(s) or serve(s) (%); nothing written', fails, what
      USING ERRCODE = '23514';
  END IF;
  RETURN QUERY SELECT * FROM "ws_switch_proof";
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_switch_guard"() FROM PUBLIC;
--> statement-breakpoint

-- Switch this brain, when it is on workspaces (H2, owner rule 21.9). A brain
-- with an anchor that is NOT on workspaces (client logins or client-level
-- items, or never migrated) keeps its levels, its bridge and its upkeep
-- triggers: nothing below runs for it, the integrity audit keeps its
-- "workspaces: not migrated" row, and mantle_ws_migrate_locked() switches
-- it once it is set up. A NOTICE, not an error: a roll of such a box must
-- not fail on a brain that is meant to stay where it is (an error would
-- stop every later migration of the release on it). A fresh install with no
-- anchor yet switches now (nothing to keep) and its later first migration
-- (mantle_ws_migrate) runs the same steps again.
DO $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  why text := "public"."mantle_ws_skip_reason"();
  r record;
BEGIN
  IF brain IS NOT NULL AND why IS NOT NULL THEN
    RAISE NOTICE '0261: this brain is not on workspaces (%): it keeps its levels and the bridge; mantle_ws_migrate_locked() switches it once it is set up', why;
    RETURN;
  END IF;
  PERFORM "public"."mantle_ws_switch_off"();
  FOR r IN SELECT * FROM "public"."mantle_ws_bridge_off"() LOOP
    RAISE NOTICE '0261 bridge off: % = %', r."step", r."n";
  END LOOP;
  FOR r IN SELECT * FROM "public"."mantle_ws_switch_guard"() LOOP
    RAISE NOTICE '0261 proof: % % % = %', r."section", r."subject", r."metric", r."n";
  END LOOP;
END
$$;
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
  -- Skipped (client logins or client-level items, 21.9; or no anchor): the
  -- brain is not on workspaces, so it is not switched either (H2).
  IF "public"."mantle_ws_skip_reason"() IS NOT NULL THEN RETURN; END IF;
  PERFORM "public"."mantle_ws_switch_off"();
  RETURN QUERY SELECT 'bridge off'::text, b."step", 'count'::text, b."n"
                 FROM "public"."mantle_ws_bridge_off"() b;
  -- The same proof as the migration's: a reach-fail raises 23514 and the
  -- whole migration rolls back (M1).
  RETURN QUERY SELECT * FROM "public"."mantle_ws_switch_guard"();
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
