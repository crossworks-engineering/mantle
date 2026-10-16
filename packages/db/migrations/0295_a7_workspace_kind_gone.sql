-- Workspaces arch A7 (plan v2 page fcc4aee4, "A7. Remove the switch-over
-- code"): mantle_workspace_kind (0159) goes. It was the tier model's kind
-- list, kept by 0273 for a brain not on workspaces yet; arch A1 made
-- mantle_kind_class (0241) the one kind class of the registry
-- (@mantle/client-types/kinds), and every brain of the fleet is on
-- workspaces since W9.
--
-- What still named it, found by pg_depend (the three nodes CHECKs) and by a
-- scan of every function body (none in 0291, 0293 or 0294):
--  - the three level CHECKs of nodes (nodes_audience_kind_ck,
--    nodes_inherited_level_ck, nodes_embedded_level_ck), on the frozen level
--    columns (0262: grants decide access);
--  - mantle_contact_share_check, the live trigger of a contact share
--    (0214, 0279): a share needs a workspace item that is not a folder,
--    written here as those kinds (the registry's contactShare kinds);
--  - mantle_team_reads and mantle_ws_reach_diff, which the operator's
--    manual switch of a box that reports "clients present"
--    (mantle_ws_migrate_locked, docs/workspaces.md "Operator notes") still
--    runs: the bridge's wanted grants and the switch guard's reach proof;
--  - mantle_inherited_level (read by mantle_page_folder_id, a client
--    reader's folder), mantle_embedded_level, mantle_open_embedded and
--    mantle_nodes_inherit_trg (the level refreshers 0204 to 0208 made; no
--    trigger calls them on a brain at 0294).
--
-- Each is the same rule with the list written in: the kinds
-- mantle_workspace_kind answered yes for (page, note, draw, table, file,
-- branch, app, formula; tasks, events and Recall maps joined the workspace
-- class in A1, never the tier model). No answer changes: the bodies are
-- the 0294 ones but for that one call, and a CHECK is dropped and made
-- again with the same rule, NOT VALID (below: why no VALIDATE).
-- workspace-kind-gone-0295.db.test.ts pins each against the old list, and
-- the contact share check against the registry's contactShare kinds.
--
-- Then the function is dropped RESTRICT, after a body scan that raises if
-- any function still names it. Every step reads what is there: a second
-- run changes nothing. No row of any table changes, no LLM work is queued
-- and no notify fires.
--
-- The `when` sits above 1790196960000 (0294's): migrate.ts skips a
-- migration whose `when` is at or below the highest one applied.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_contact_share_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF new.contact_id IS NULL THEN
    RETURN new;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" c
     WHERE c.id = new.contact_id AND c.owner_id = new.owner_id AND c.type = 'contact'
  ) THEN
    RAISE EXCEPTION 'shares: contact % is not a contact of this owner', new.contact_id
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = new.node_id AND n.owner_id = new.owner_id
       AND n.type = new.node_type
       AND n.type IN ('page', 'note', 'draw', 'table', 'file', 'app', 'formula')
  ) THEN
    RAISE EXCEPTION 'shares: a contact share needs a workspace item that is not a folder'
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_embedded_level(o uuid, target uuid, t node_type)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE WHEN NOT (t IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app', 'formula')) THEN NULL ELSE (
    -- Index lookups only (LATERAL): a join here let the planner scan
    -- whole tables once per row refreshed.
    WITH RECURSIVE up(id) AS (
      SELECT p.from_id FROM "public"."node_embeds" p
       WHERE p.to_id = target
         AND EXISTS (SELECT 1 FROM "public"."nodes" x WHERE x.id = p.from_id AND x.owner_id = o)
      UNION
      SELECT p.from_id FROM up
       CROSS JOIN LATERAL (
         SELECT e.from_id FROM "public"."node_embeds" e WHERE e.to_id = up.id
       ) p
       WHERE EXISTS (SELECT 1 FROM "public"."nodes" x WHERE x.id = p.from_id AND x.owner_id = o)
    )
    SELECT CASE WHEN bool_or(l.lvl = 'client') THEN 'client'
                WHEN bool_or(l.lvl = 'team') THEN 'team' END
      FROM up
     CROSS JOIN LATERAL (SELECT m.inherited_level AS lvl FROM "public"."nodes" m WHERE m.id = up.id) l
     WHERE up.id <> target
  ) END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_inherited_level(o uuid, p ltree, t node_type)
 RETURNS text
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
  SELECT CASE WHEN NOT (t IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app', 'formula')) OR nlevel(p) < 2 THEN NULL ELSE (
    SELECT a."share_level" FROM "public"."nodes" a
     WHERE a."owner_id" = o AND a."share_level" IS NOT NULL
       AND a."path" @> p AND (t <> 'branch' OR a."path" <> p)
     ORDER BY nlevel(a."path") DESC
     LIMIT 1
  ) END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_nodes_inherit_trg()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."type" IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app', 'formula') AND nlevel(NEW."path") > 1
     AND subpath(NEW."path", 0, 1)::text IN
         ('files', 'notes', 'pages', 'draw', 'tables', 'formulas', 'apps') THEN
    PERFORM pg_advisory_xact_lock_shared("public"."mantle_share_lock_key"(NEW."owner_id"));
  END IF;
  NEW."inherited_level" := "public"."mantle_inherited_level"(NEW."owner_id", NEW."path", NEW."type");
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_open_embedded(o uuid, start uuid[], lvl text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE "public"."nodes" n
     SET "embedded_level" = lvl
   WHERE lvl IN ('team', 'client')
     AND n.owner_id = o AND n.id IN (SELECT r.id FROM "public"."mantle_embeds_reached"(o, start) r)
     AND n.type IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app', 'formula')
     AND (n."embedded_level" IS NULL OR (n."embedded_level" = 'team' AND lvl = 'client'));
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_team_reads(t node_type, audience text, inherited text, embedded text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  -- The team role's read rule today (nodes_viewer_read, 0208), for a brain
  -- item: its own level, its folder's share or an embedder's share.
  -- Never NULL: a missing share or embed level reads as "no" (a NULL here
  -- once dropped admin-only apps out of every planned grant).
  SELECT coalesce(t IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app', 'formula'), false)
     AND (coalesce(audience IN ('team', 'client', 'public'), false)
          OR coalesce(inherited IN ('team', 'client'), false)
          OR coalesce(embedded IN ('team', 'client', 'public'), false))
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mantle_ws_reach_diff()
 RETURNS TABLE(section text, subject text, metric text, n bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
       AND n."type" IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app', 'formula')
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
    UNION
    -- The spaces fold (0267): a moved item was read before by its author,
    -- by the Admin users and the Admin assistant when its home row grants
    -- Admin or Team, and by the members and the Team assistant when it
    -- grants Team (9.3; the assistants' gains signed off, 18.13).
    SELECT 'login:' || f."login_id", f."node_id" FROM "public"."space_fold_items" f
     WHERE f."login_id" IS NOT NULL
    UNION
    SELECT 'login:' || u."id", f."node_id" FROM auth.users u, "public"."space_fold_items" f
     WHERE u."role" = 'member' AND f."grant_team"
    UNION
    SELECT 'assistant:team', f."node_id" FROM "public"."space_fold_items" f WHERE f."grant_team"
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
$function$;
--> statement-breakpoint
-- The nodes level CHECKs, the same rule with the list written in. One
-- ACCESS EXCLUSIVE lock on nodes with a short wait and a retry (as 0273),
-- then each CHECK dropped and added again NOT VALID, and left NOT VALID:
-- no VALIDATE, so no scan of nodes runs under the lock.
--
-- Why not validate after the lock: migrate.ts runs each migration in one
-- transaction, and a lock is held to its commit, so a VALIDATE in this
-- migration (even in a later statement) would scan nodes under ACCESS
-- EXCLUSIVE, stopping every read and write of the brain for two full
-- scans. A VALIDATE on its own (SHARE UPDATE EXCLUSIVE) would need its own
-- transaction: a further migration or a step after the migrations, for a
-- flag that guards nothing here. A NOT VALID CHECK guards every row written
-- after it exactly as a valid one does; what it does not do is prove the
-- rows already there. Those are proven: the old CHECK, the same rule, was
-- valid where it was (0160 validated the audience one and 0208 the
-- embedded one; 0204 left the inherited one NOT VALID) and is dropped
-- under the same lock, so no row changed between its proof and the new
-- CHECK. The level columns are frozen besides (0262: grants decide
-- access). A box that wants the flag set may run VALIDATE CONSTRAINT by
-- hand at any time: it takes SHARE UPDATE EXCLUSIVE and blocks no read or
-- write.
DO $$
DECLARE
  attempt int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c."conrelid" = '"public"."nodes"'::regclass
                    AND pg_get_constraintdef(c."oid") LIKE '%mantle_workspace_kind%') THEN
    RETURN;
  END IF;
  LOOP
    attempt := attempt + 1;
    BEGIN
      LOCK TABLE "public"."nodes" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= 20 THEN
        RAISE EXCEPTION '0295: nodes stayed busy for 20 attempts; run the migration again at a quieter time'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
  ALTER TABLE "public"."nodes" DROP CONSTRAINT IF EXISTS "nodes_audience_kind_ck";
  ALTER TABLE "public"."nodes" ADD CONSTRAINT "nodes_audience_kind_ck"
    CHECK ("audience" = 'admin' OR "type" IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app', 'formula')) NOT VALID;
  ALTER TABLE "public"."nodes" DROP CONSTRAINT IF EXISTS "nodes_inherited_level_ck";
  ALTER TABLE "public"."nodes" ADD CONSTRAINT "nodes_inherited_level_ck"
    CHECK ("inherited_level" IS NULL
           OR ("inherited_level" IN ('team', 'client') AND "type" IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app', 'formula'))) NOT VALID;
  ALTER TABLE "public"."nodes" DROP CONSTRAINT IF EXISTS "nodes_embedded_level_ck";
  ALTER TABLE "public"."nodes" ADD CONSTRAINT "nodes_embedded_level_ck"
    CHECK ("embedded_level" IS NULL
           OR ("embedded_level" IN ('team', 'client') AND "type" IN ('page', 'note', 'draw', 'table', 'file', 'branch', 'app', 'formula'))) NOT VALID;
END
$$;
--> statement-breakpoint
-- The body scan: no function may still name mantle_workspace_kind.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p."oid"::regprocedure::text AS "sig"
      FROM pg_proc p
      JOIN pg_namespace ns ON ns."oid" = p."pronamespace"
     WHERE ns."nspname" IN ('public', 'auth')
       AND p."proname" <> 'mantle_workspace_kind'
       AND p."prosrc" ~ '\mmantle_workspace_kind\M'
  LOOP
    RAISE EXCEPTION '0295: % still calls mantle_workspace_kind; nothing was dropped', f."sig"
      USING ERRCODE = 'dependent_objects_still_exist';
  END LOOP;
END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_workspace_kind"("public"."node_type") RESTRICT;
