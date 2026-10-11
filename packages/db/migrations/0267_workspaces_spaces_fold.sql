-- Workspaces W6b: personal spaces fold into the brain (plan page 4887b8e7,
-- sections 9.3, 9.5, 11 (W6b), 17 R1, 18 S3, 21.8 rows 8 and 17, 21.9).
--
-- Every item a member's personal space owns becomes a brain item
-- (nodes.owner_id = the brain), homed in the workspace 0264 recorded for it
-- (space_item_homes: the login's private workspace, "<name> (only you)", or
-- the "Former user" workspace of a login that is gone), with exactly the
-- grants that home row names: its home (Write off) and Admin and Team where
-- grant_admin and grant_team say so (Write off, 9.3). The W5c contract:
--
--  - mantle_ws_review_off() runs first. It records the items made since
--    0264 and recomputes grant_admin and grant_team from LIVE sharing, the
--    live trash (deleted_at) and the live logins, so the grants written
--    here are today's, not 0264's.
--  - A row a space owns with no space_items row (a folder the member made)
--    takes the home of its space (the home of its other items, else its
--    login's private workspace, made here when missing; a space with no
--    login: a "Former user" workspace keyed by the space). The kind roots
--    of a space (one-label branch rows such as "pages") are structure, not
--    items, and every brain already has its own: they stay in their space,
--    empty, and are counted.
--  - The snapshot flag: an accepted item is a brain item already and does
--    not move. Its author's read-only snapshot copy (S3) needs today's
--    redactors (the author's level), which run in the app, not in SQL: the
--    app makes it (snapshot-copies.ts, at boot and by hand), for exactly
--    the homes with snapshot = true, recorded in space_item_homes.
--    snapshot_node_id.
--
-- Rows change, bytes do not. A file keeps its bytes where they are, in its
-- space's directory (data.space_file names the space; the brain's file
-- readers, rename and move honour it), and moves from space_files (the
-- personal mirror) to files in the tree; an
-- app keeps its app row, its data, its app-db file and its history (their
-- owner_id moves with it: node_snapshots, app_databases, app_access_log and
-- any other table that names the space as owner). A name that would clash in
-- the brain is made unique, never overwritten: a folder whose path a brain
-- folder (or another space's folder) already has takes a short suffix on its
-- last label, its subtree with it; a slug the brain already has takes a
-- short suffix. Every change is recorded (space_fold_items).
--
-- No LLM work, no extractor notify, no queue row (plan 5.3, 9.5): the move
-- is an UPDATE (node_ingested fires on INSERT only), and every moved item
-- without an embedding is stamped data.extract_skipped (reason
-- 'spaces_fold', the extractor's own terminal-skip stamp), so the boot drain
-- and the missed-event sweep do not queue it. Its next edit makes it
-- eligible as any item (21.8 row 16): local chunks for everyone, LLM work
-- only where a workspace with an assistant reads it (llm-guard.ts).
--
-- Then the spaces are archived: archive_spaces (every personal space row),
-- archive_space_items (0264, rows made since added), and the space_items
-- rows of the moved items go (archived first; the final sharing and trash
-- are in space_fold_items too). An accepted row stays: it is its author's
-- read path (member-accepted.ts) until the snapshot copy replaces it. The spaces rows stay (a kind root still names its
-- space, and nodes.owner_id cascades from spaces): nothing is dropped. The
-- space role is retired by the app (viewer-roles.ts: NOLOGIN at boot); its
-- functions and policies stay until W8.
--
-- The proof, inside the transaction (23514 rolls everything back): no item
-- left in a personal space but the kind roots, every moved item has exactly
-- its recorded home and grants, every author reaches every item of its
-- space through its private workspace, no login reads a moved item it did
-- not read before (the author; Admin users the items 0264 grants Admin or
-- Team; members the items it grants Team), and no grant outside the moved
-- items changed. Assistants reading what their workspace now holds (Admin:
-- the submitted and left-behind items, Team: team-shared drafts) are the
-- gains the owner signed off (9.3, 18.13); they are listed, not refused.
--
-- mantle_ws_spaces_fold() is idempotent (a second run moves nothing) and
-- does nothing on a brain not on workspaces (21.9: clients present, or no
-- anchor yet); mantle_ws_migrate runs it at its end when such a brain
-- switches later.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ── 1. The records ───────────────────────────────────────────────────────────

-- Every personal space row, as it was. No foreign key; archived_at only.
CREATE TABLE IF NOT EXISTS "public"."archive_spaces" (
  "id"          uuid PRIMARY KEY,
  "kind"        text NOT NULL,
  "login_id"    uuid,
  "orphaned_at" timestamptz,
  "created_at"  timestamptz NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One row per item moved: where it came from and what it became. No
-- foreign key (it outlives the node and the space).
CREATE TABLE IF NOT EXISTS "public"."space_fold_items" (
  "node_id"           uuid PRIMARY KEY,
  "space_id"          uuid NOT NULL,
  "login_id"          uuid,
  "node_type"         text NOT NULL,
  "home_workspace_id" uuid NOT NULL,
  "grant_admin"       boolean NOT NULL,
  "grant_team"        boolean NOT NULL,
  "sharing"           text,
  "deleted_at"        timestamptz,
  "old_path"          text NOT NULL,
  "new_path"          text NOT NULL,
  "old_slug"          text,
  "new_slug"          text,
  "folded_at"         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_fold_items_home_idx"
  ON "public"."space_fold_items" ("home_workspace_id");
--> statement-breakpoint
-- The author's snapshot copy of an accepted item (S3), once the app made it.
ALTER TABLE "public"."space_item_homes"
  ADD COLUMN IF NOT EXISTS "snapshot_node_id" uuid;
--> statement-breakpoint
-- Admin pool and definer functions only (access-matrix.ts).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['archive_spaces', 'space_fold_items'] LOOP
    EXECUTE format('ALTER TABLE "public".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON "public".%I FROM PUBLIC', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── 2. The check ─────────────────────────────────────────────────────────────

-- Numbers only.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_spaces_fold_check"()
  RETURNS TABLE ("metric" text, "n" bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT 'items left in a personal space', count(*)
    FROM "public"."nodes" n JOIN "public"."spaces" s ON s."id" = n."owner_id"
   WHERE s."kind" = 'personal' AND NOT (n."type" = 'branch' AND nlevel(n."path") = 1)
  UNION ALL
  SELECT 'kind roots left in a personal space', count(*)
    FROM "public"."nodes" n JOIN "public"."spaces" s ON s."id" = n."owner_id"
   WHERE s."kind" = 'personal' AND n."type" = 'branch' AND nlevel(n."path") = 1
  UNION ALL
  SELECT 'kind roots left with children', count(*)
    FROM "public"."nodes" n JOIN "public"."spaces" s ON s."id" = n."owner_id"
   WHERE s."kind" = 'personal' AND n."type" = 'branch' AND nlevel(n."path") = 1
     AND EXISTS (SELECT 1 FROM "public"."nodes" c
                  WHERE c."owner_id" = n."owner_id" AND c."id" <> n."id" AND c."path" <@ n."path")
  UNION ALL
  SELECT 'space_items rows other than accepted', count(*) FROM "public"."space_items" si
   WHERE si."review_state" <> 'accepted'
  UNION ALL
  SELECT 'accepted rows kept (the author read path until its snapshot copy)', count(*)
    FROM "public"."space_items" si WHERE si."review_state" = 'accepted'
  UNION ALL
  SELECT 'items moved', count(*) FROM "public"."space_fold_items"
  UNION ALL
  SELECT 'moved items gone since', count(*) FROM "public"."space_fold_items" f
   WHERE NOT EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n."id" = f."node_id")
  UNION ALL
  SELECT 'moved items without their home', count(*)
    FROM "public"."space_fold_items" f JOIN "public"."nodes" n ON n."id" = f."node_id"
   WHERE n."home_ws" IS DISTINCT FROM f."home_workspace_id"
  UNION ALL
  SELECT 'moved items renamed (path or slug)', count(*) FROM "public"."space_fold_items" f
   WHERE f."old_path" <> f."new_path" OR f."old_slug" IS DISTINCT FROM f."new_slug"
  UNION ALL
  -- A folded file whose name another file in its folder has (ignoring case):
  -- its delete or a reader would reach the other's bytes (fix round 1, H1).
  SELECT 'folded files sharing a name in their folder', count(*)
    FROM "public"."space_fold_items" f JOIN "public"."nodes" n ON n."id" = f."node_id"
   WHERE n."type" = 'file'
     AND EXISTS (SELECT 1 FROM "public"."nodes" o
                  WHERE o."owner_id" = n."owner_id" AND o."type" = 'file' AND o."id" <> n."id"
                    AND o."path" = n."path"
                    AND lower(coalesce(o."data"->>'filename', o."slug"))
                        = lower(coalesce(n."data"->>'filename', n."slug")))
  UNION ALL
  SELECT 'snapshot copies wanted', count(*) FROM "public"."space_item_homes" h WHERE h."snapshot"
  UNION ALL
  SELECT 'snapshot copies made', count(*) FROM "public"."space_item_homes" h
   WHERE h."snapshot" AND h."snapshot_node_id" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n."id" = h."snapshot_node_id")
  UNION ALL
  SELECT 'archive rows: spaces', count(*) FROM "public"."archive_spaces"
  UNION ALL
  SELECT 'personal spaces not archived', count(*) FROM "public"."spaces" s
   WHERE s."kind" = 'personal'
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_spaces" a WHERE a."id" = s."id")
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_spaces_fold_check"() FROM PUBLIC;
--> statement-breakpoint

-- A login's private workspace (21.8 row 8, plan 15): its own, made now
-- when it has none (or only an archived one), "<name> (only you)", the
-- login its only user and Moderator. NULL for a login that does not exist,
-- is disabled, or on a brain not on workspaces. The app calls it on the
-- system pool before a create that may land there (a member's create, the
-- member app tools); nothing else makes one behind a login's back.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_private_workspace"(login uuid)
  RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  ws uuid;
  label text;
BEGIN
  IF login IS NULL OR brain IS NULL OR "public"."mantle_ws_skip_reason"() IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM "public"."workspaces" w WHERE w."owner_id" = brain AND w."is_admin") THEN
    RETURN NULL;
  END IF;
  SELECT left(coalesce(nullif(btrim(u."display_name"), ''), split_part(u."email", '@', 1)), 100)
    INTO label FROM auth.users u WHERE u."id" = login AND u."disabled_at" IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- One at a time per login: two first creates make one workspace.
  PERFORM pg_advisory_xact_lock(hashtext('mantle_ws_private_workspace'), hashtext(login::text));
  SELECT p."workspace_id" INTO ws
    FROM "public"."private_workspaces" p
    JOIN "public"."workspaces" w ON w."id" = p."workspace_id" AND w."archived_at" IS NULL
   WHERE p."login_id" = login;
  IF ws IS NOT NULL THEN RETURN ws; END IF;
  INSERT INTO "public"."workspaces" ("owner_id", "name", "description", "created_by")
  VALUES (brain, btrim(label || ' (only you)'), 'Your own work. Only you see it.', login)
  RETURNING "id" INTO ws;
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
  VALUES (ws, login, true);
  INSERT INTO "public"."private_workspaces" ("login_id", "workspace_id") VALUES (login, ws)
  ON CONFLICT ("login_id") DO UPDATE SET "workspace_id" = EXCLUDED."workspace_id";
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  -- The same event 0264 writes: a login removed later is found by it
  -- (its workspace becomes its Former user workspace, mantle_ws_review_off).
  VALUES (ws, NULL, 'review_off.private', jsonb_build_object('login', login));
  RETURN ws;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_private_workspace"(uuid) FROM PUBLIC;
--> statement-breakpoint

-- A uuid from a transaction setting, or NULL (unset, empty or not a uuid).
CREATE OR REPLACE FUNCTION "public"."mantle_setting_uuid"(name text)
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN coalesce(current_setting(name, true), '')
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN current_setting(name, true)::uuid END
$$;
--> statement-breakpoint

-- The home of a new item (21.8 row 7, plan 15; W6b). Two transaction
-- settings, set only by the app's system transactions for a create it has
-- checked, choose it:
--  - mantle.create_ws: the workspace the login creates in (the request's
--    current workspace, ?ws=, which the login moderates; the member app
--    tools' private workspace). It wins when it can hold the kind.
--  - mantle.private_ws: a member's or client's create. Then the folder's
--    home when the item lands in a folder the login may edit (the create
--    check, 0266, refuses a folder it may not), else the login's private
--    workspace. Never Admin by default: a non-Admin login's work is its
--    own until it shares it.
-- With neither set (every create before W6b, an Admin user's create without
-- ?ws=, the system's own) the rule is as before (0261): the folder's home,
-- else Admin.
CREATE OR REPLACE FUNCTION "public"."mantle_default_home"(
  o uuid, t "public"."node_type", p ltree)
  RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  admin_ws uuid;
  home uuid;
  req uuid := "public"."mantle_setting_uuid"('mantle.create_ws');
  priv uuid := "public"."mantle_setting_uuid"('mantle.private_ws');
  fw uuid[];
  ok boolean;
BEGIN
  IF o IS NULL OR o IS DISTINCT FROM "public"."mantle_brain_id"() THEN RETURN NULL; END IF;
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = o AND w."is_admin" LIMIT 1;
  IF admin_ws IS NULL THEN RETURN NULL; END IF;
  -- A kind's root folder is the brain's structure, whoever's request made
  -- it first: as before (0261).
  IF t = 'branch' AND nlevel(p) = 1 THEN
    req := NULL;
    priv := NULL;
  END IF;
  IF req IS NOT NULL
     AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."id" = req AND w."owner_id" = o AND w."archived_at" IS NULL)
     AND "public"."mantle_grant_kind_ok"(t, req) THEN
    RETURN req;
  END IF;
  IF "public"."mantle_kind_class"(t) <> 'workspace' THEN
    IF priv IS NOT NULL THEN
      RAISE EXCEPTION 'this kind of item lives in the Admin workspace only' USING ERRCODE = '42501';
    END IF;
    RETURN admin_ws;
  END IF;
  SELECT f."home_ws", f."write_ws" INTO home, fw FROM "public"."nodes" f
   WHERE f."id" = "public"."mantle_parent_folder"(o, t, p);
  ok := home IS NOT NULL
        AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                     WHERE w."id" = home AND w."archived_at" IS NULL)
        AND "public"."mantle_grant_kind_ok"(t, home);
  IF priv IS NOT NULL THEN
    IF ok AND (NOT "public"."mantle_scope_active"() OR coalesce("public"."mantle_may_edit"(home, fw), false)) THEN
      RETURN home;
    END IF;
    IF EXISTS (SELECT 1 FROM "public"."workspaces" w
                WHERE w."id" = priv AND w."owner_id" = o AND w."archived_at" IS NULL) THEN
      RETURN priv;
    END IF;
    RAISE EXCEPTION 'no workspace to create this item in' USING ERRCODE = '42501';
  END IF;
  IF ok THEN RETURN home; END IF;
  RETURN admin_ws;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_default_home"(uuid, "public"."node_type", ltree) FROM PUBLIC;
--> statement-breakpoint

-- The extractor notify (0165) stays quiet in a transaction that says so
-- (mantle.ingest_notify = off): the author's read-only snapshot copies (S3,
-- snapshot-copies.ts) are made with no LLM work and no queue row (plan 5.3,
-- 9.5). Nothing else sets it.
CREATE OR REPLACE FUNCTION "public"."notify_node_ingested"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF new.type IS DISTINCT FROM 'branch'::node_type
     AND "public"."mantle_is_brain_space"(new.owner_id)
     AND coalesce(current_setting('mantle.ingest_notify', true), '') <> 'off' THEN
    PERFORM pg_notify('node_ingested', new.id::text);
  END IF;
  RETURN new;
END
$$;
--> statement-breakpoint

-- The reach diff (0261) knows the moved items: the switch guard compares
-- with today's reach, and a moved item is no longer in a space. Its body is
-- 0261's plus the fold's rows in the OLD set (as the fold's own proof).
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
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_reach_diff"() FROM PUBLIC;
--> statement-breakpoint

-- ── 3. The work ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."mantle_ws_spaces_fold"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  admin_ws uuid;
  team_ws uuid;
  why text;
  r record;
  ws uuid;
  c bigint;
  lvl int;
  moved uuid[];
  grants_before text;
  grants_after text;
  bad bigint;
  t record;
BEGIN
  IF brain IS NOT NULL THEN
    SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
     WHERE w."owner_id" = brain AND w."is_admin";
    SELECT w."id" INTO team_ws FROM "public"."workspaces" w
     WHERE w."owner_id" = brain AND w."bridge_key" = 'team';
  END IF;
  why := "public"."mantle_ws_skip_reason"();
  IF admin_ws IS NULL OR why IS NOT NULL THEN
    RETURN QUERY SELECT 'fold'::text, 'brain'::text,
                        ('not on workspaces (' || coalesce(why, 'no Admin workspace')
                         || '): nothing moved')::text, 0::bigint;
    RETURN;
  END IF;

  -- 1. The homes and grants of today (W5c contract): records the items made
  --    since 0264, refreshes grant_admin and grant_team from live sharing,
  --    the live trash and the live logins.
  RETURN QUERY SELECT 'review off: ' || x."section", x."subject", x."metric", x."n"
                 FROM "public"."mantle_ws_review_off"() x;

  -- Writers in a space while it moves (the routes are gone; an old server
  -- may still be up during a roll). Row locks on the personal spaces and
  -- every space_items row, in id order, not a table lock. What they stop
  -- (W6b fix round 1, the wording corrected): a NEW row in a personal space
  -- (its foreign key check takes FOR KEY SHARE on its space row, which FOR
  -- UPDATE blocks) and any change to a space_items row. They do not stop an
  -- edit or a delete of an existing item row: that is serialised by the
  -- item row's own lock against the fold's UPDATE below (the later one
  -- waits; a row deleted before the fold reads it is simply not moved).
  -- A brain write locks its brain space row only, so it never waits. A
  -- table lock in EXCLUSIVE mode waited on every open brain insert (its
  -- foreign key check needs ROW SHARE on spaces) and timed out under load.
  PERFORM 1 FROM "public"."spaces" s WHERE s."kind" = 'personal' ORDER BY s."id" FOR UPDATE;
  PERFORM 1 FROM "public"."space_items" si ORDER BY si."node_id" FOR UPDATE;
  PERFORM "public"."mantle_heads_bypass"('0267_workspaces_spaces_fold');

  -- What must not change outside the moved items: every other grant.
  SELECT count(*)::text || ':' || coalesce(sum(hashtext(concat_ws('|', g."node_id", g."workspace_id",
           g."write", g."is_home", g."excluded", g."via_folder_id")))::text, '0')
    INTO grants_before
    FROM "public"."item_grants" g
   WHERE NOT EXISTS (SELECT 1 FROM "public"."nodes" n JOIN "public"."spaces" s ON s."id" = n."owner_id"
                      WHERE n."id" = g."node_id" AND s."kind" = 'personal');

  -- 2. The rows to move: every row a personal space owns but its kind roots.
  IF to_regclass('pg_temp.ws_fold') IS NULL THEN
    CREATE TEMP TABLE pg_temp."ws_fold" (
      "node_id" uuid PRIMARY KEY, "space_id" uuid NOT NULL, "login_id" uuid,
      "type" "public"."node_type" NOT NULL, "old_path" ltree NOT NULL, "new_path" ltree NOT NULL,
      "old_slug" text, "new_slug" text, "home" uuid, "grant_admin" boolean NOT NULL,
      "grant_team" boolean NOT NULL, "sharing" text, "deleted_at" timestamptz,
      "embedded" boolean NOT NULL) ON COMMIT DROP;
  END IF;
  TRUNCATE pg_temp."ws_fold";
  -- A member's files sit under space_files, the mirror of the brain's
  -- files: they move to files (their bytes stay in the space's directory,
  -- named by data.space_file).
  INSERT INTO pg_temp."ws_fold"
  SELECT n."id", s."id", s."login_id", n."type", n."path",
         CASE WHEN subpath(n."path", 0, 1) = 'space_files'::ltree
              THEN CASE WHEN nlevel(n."path") > 1 THEN 'files'::ltree || subpath(n."path", 1)
                        ELSE 'files'::ltree END
              ELSE n."path" END,
         n."slug", n."slug",
         h."home_workspace_id", coalesce(h."grant_admin", false), coalesce(h."grant_team", false),
         si."sharing", si."deleted_at", n."embedding" IS NOT NULL
    FROM "public"."nodes" n
    JOIN "public"."spaces" s ON s."id" = n."owner_id" AND s."kind" = 'personal'
    LEFT JOIN "public"."space_item_homes" h ON h."node_id" = n."id"
    LEFT JOIN "public"."space_items" si ON si."node_id" = n."id"
   WHERE NOT (n."type" = 'branch' AND nlevel(n."path") = 1);
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'fold'::text, 'personal rows'::text, 'to move'::text, c;

  -- An item in its author's trash (a member app the author deleted): its
  -- private workspace only, no Admin or Team grant (owner decision, W6b),
  -- marked data.trashedBeforeFold below so the author can find and delete
  -- it. Nothing of it is removed: the app, its data and its app-db file
  -- move as every other item.
  UPDATE pg_temp."ws_fold" f SET "grant_admin" = false, "grant_team" = false
   WHERE f."deleted_at" IS NOT NULL;

  -- A row with no recorded home (a folder): the home of its space's other
  -- items, else its login's private workspace, else the space's Former
  -- user workspace.
  UPDATE pg_temp."ws_fold" f
     SET "home" = (SELECT h."home_workspace_id"
                     FROM "public"."space_item_homes" h
                     JOIN "public"."nodes" x ON x."id" = h."node_id"
                    WHERE x."owner_id" = f."space_id" AND h."state_before" <> 'accepted'
                    ORDER BY h."node_id" LIMIT 1)
   WHERE f."home" IS NULL;
  UPDATE pg_temp."ws_fold" f SET "home" = p."workspace_id"
    FROM "public"."private_workspaces" p
   WHERE f."home" IS NULL AND p."login_id" = f."login_id";
  UPDATE pg_temp."ws_fold" f SET "home" = fw."workspace_id"
    FROM "public"."former_user_workspaces" fw
   WHERE f."home" IS NULL AND f."login_id" IS NULL AND fw."former_key" = f."space_id";
  -- A home its live author cannot reach any more (archived since 0264; W6b
  -- fix round 1): the author's live private workspace when it has one,
  -- else its own archived private workspace, which is un-archived (its
  -- author's own work goes back where its author reaches it; recorded as a
  -- workspace event), else none (a private workspace is made below). Only
  -- the author's OWN private workspace is ever un-archived (fix round 2):
  -- an archived workspace the brain keeps (a Former user workspace, any
  -- shared one) stays archived, and the author's item leaves it. Without
  -- this the proof below refused the whole fold.
  UPDATE pg_temp."ws_fold" f SET "home" = p."workspace_id"
    FROM "public"."private_workspaces" p
    JOIN "public"."workspaces" w ON w."id" = p."workspace_id" AND w."archived_at" IS NULL
   WHERE p."login_id" = f."login_id" AND f."home" IS NOT NULL AND f."home" <> p."workspace_id"
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u."id" = f."login_id")
     AND EXISTS (SELECT 1 FROM "public"."workspaces" a
                  WHERE a."id" = f."home" AND a."archived_at" IS NOT NULL);
  UPDATE pg_temp."ws_fold" f SET "home" = p."workspace_id"
    FROM "public"."private_workspaces" p
   WHERE p."login_id" = f."login_id" AND f."home" IS NOT NULL AND f."home" <> p."workspace_id"
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u."id" = f."login_id")
     AND EXISTS (SELECT 1 FROM "public"."workspaces" a
                  WHERE a."id" = f."home" AND a."archived_at" IS NOT NULL);
  UPDATE pg_temp."ws_fold" f SET "home" = NULL
   WHERE f."home" IS NOT NULL
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u."id" = f."login_id")
     AND EXISTS (SELECT 1 FROM "public"."workspaces" a
                  WHERE a."id" = f."home" AND a."archived_at" IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                      WHERE p."login_id" = f."login_id");
  WITH back AS (
    UPDATE "public"."workspaces" w SET "archived_at" = NULL, "updated_at" = now()
     WHERE w."archived_at" IS NOT NULL
       AND w."id" IN (SELECT f."home" FROM pg_temp."ws_fold" f
                       JOIN auth.users u ON u."id" = f."login_id"
                       JOIN "public"."private_workspaces" p
                         ON p."workspace_id" = f."home" AND p."login_id" = f."login_id")
    RETURNING w."id"
  ), ev AS (
    INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
    SELECT b."id", NULL, 'spaces_fold.unarchived', '{}'::jsonb FROM back b
    RETURNING 1
  )
  SELECT count(*) INTO c FROM ev;
  RETURN QUERY SELECT 'fold'::text, 'archived homes of live authors'::text, 'un-archived'::text, c;
  c := 0;
  FOR r IN
    SELECT DISTINCT f."login_id" AS login,
           left(coalesce(nullif(btrim(u."display_name"), ''), split_part(u."email", '@', 1)), 100) AS label
      FROM pg_temp."ws_fold" f JOIN auth.users u ON u."id" = f."login_id"
     WHERE f."home" IS NULL
     ORDER BY 1
  LOOP
    INSERT INTO "public"."workspaces" ("owner_id", "name", "description", "created_by")
    VALUES (brain, btrim(r.label || ' (only you)'), 'Your own work. Only you see it.', r.login)
    RETURNING "id" INTO ws;
    INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
    VALUES (ws, r.login, true);
    INSERT INTO "public"."private_workspaces" ("login_id", "workspace_id") VALUES (r.login, ws);
    INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
    VALUES (ws, NULL, 'review_off.private', jsonb_build_object('login', r.login));
    UPDATE pg_temp."ws_fold" f SET "home" = ws WHERE f."home" IS NULL AND f."login_id" = r.login;
    c := c + 1;
  END LOOP;
  FOR r IN
    SELECT DISTINCT f."space_id" AS sp FROM pg_temp."ws_fold" f
     WHERE f."home" IS NULL AND f."login_id" IS NULL ORDER BY 1
  LOOP
    INSERT INTO "public"."workspaces" ("owner_id", "name", "description")
    VALUES (brain, 'Former user', 'The work of a login that was removed. It has no users; an Admin user may join it.')
    RETURNING "id" INTO ws;
    INSERT INTO "public"."former_user_workspaces" ("former_key", "workspace_id") VALUES (r.sp, ws);
    INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
    VALUES (ws, NULL, 'review_off.former', '{}'::jsonb);
    UPDATE pg_temp."ws_fold" f SET "home" = ws WHERE f."home" IS NULL AND f."space_id" = r.sp;
    c := c + 1;
  END LOOP;
  RETURN QUERY SELECT 'fold'::text, 'workspaces for rows with no recorded home'::text, 'made'::text, c;
  SELECT count(*) INTO bad FROM pg_temp."ws_fold" f WHERE f."home" IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'spaces fold: % row(s) without a home; nothing written', bad USING ERRCODE = '23514';
  END IF;

  -- 3. Names made unique in the brain. Folders first, shallow to deep: a
  --    folder whose path a brain folder (or an earlier folder of another
  --    space) has takes a suffix on its last label, its subtree with it.
  FOR lvl IN SELECT DISTINCT nlevel(f."new_path") FROM pg_temp."ws_fold" f
              WHERE f."type" = 'branch' ORDER BY 1 LOOP
    FOR r IN
      SELECT f."node_id", f."space_id", f."new_path" AS p
        FROM pg_temp."ws_fold" f
       WHERE f."type" = 'branch' AND nlevel(f."new_path") = lvl
         AND (EXISTS (SELECT 1 FROM "public"."nodes" b
                       WHERE b."owner_id" = brain AND b."type" = 'branch' AND b."path" = f."new_path")
              OR EXISTS (SELECT 1 FROM pg_temp."ws_fold" o
                          WHERE o."type" = 'branch' AND o."new_path" = f."new_path"
                            AND o."node_id" < f."node_id"))
       ORDER BY f."node_id"
    LOOP
      UPDATE pg_temp."ws_fold" f
         SET "new_path" = CASE WHEN f."new_path" = r.p THEN x.np
                               ELSE x.np || subpath(f."new_path", nlevel(r.p)) END
        FROM (SELECT subpath(r.p, 0, nlevel(r.p) - 1)
                     || text2ltree(subpath(r.p, nlevel(r.p) - 1, 1)::text || '_'
                                   || left(md5(r.node_id::text), 6)) AS np) x
       WHERE f."space_id" = r.space_id AND f."new_path" <@ r.p;
    END LOOP;
  END LOOP;
  -- A slug (the brain's slugs are unique per kind of row): a suffix.
  UPDATE pg_temp."ws_fold" f
     SET "new_slug" = f."new_slug" || '-' || left(md5(f."node_id"::text), 6)
   WHERE f."new_slug" IS NOT NULL AND f."type" NOT IN ('branch', 'file')
     AND (EXISTS (SELECT 1 FROM "public"."nodes" b
                   WHERE b."owner_id" = brain AND b."slug" = f."new_slug"
                     AND b."type" NOT IN ('branch', 'file'))
          OR EXISTS (SELECT 1 FROM pg_temp."ws_fold" o
                      WHERE o."new_slug" = f."new_slug" AND o."type" NOT IN ('branch', 'file')
                        AND o."node_id" < f."node_id"));
  -- A file's name is unique per folder, case-insensitively (W6b fix round
  --    1, H1): its name is data.filename, which every brain file reader,
  --    the files watcher and a delete build the tree path from, so a folded
  --    file that kept a brain file's name would read, or on its delete
  --    unlink, the brain file's bytes. The name a file keeps is its
  --    data.filename (else its slug); on a clash with a brain file or an
  --    earlier folded file in the same folder (ignoring case) it takes a
  --    suffix before its extension. The slug is set to match, data.filename
  --    too (step 4), and new_slug records it.
  UPDATE pg_temp."ws_fold" f
     SET "new_slug" = coalesce(nullif(n."data"->>'filename', ''), n."slug", n."id"::text)
    FROM "public"."nodes" n
   WHERE n."id" = f."node_id" AND f."type" = 'file';
  UPDATE pg_temp."ws_fold" f
     SET "new_slug" = CASE WHEN f."new_slug" ~ '\.[A-Za-z0-9]{1,10}$'
                           THEN regexp_replace(f."new_slug", '(\.[A-Za-z0-9]{1,10})$',
                                               '-' || left(md5(f."node_id"::text), 6) || '\1')
                           ELSE f."new_slug" || '-' || left(md5(f."node_id"::text), 6) END
   WHERE f."type" = 'file'
     AND (EXISTS (SELECT 1 FROM "public"."nodes" b
                   WHERE b."owner_id" = brain AND b."type" = 'file' AND b."path" = f."new_path"
                     AND (lower(b."slug") = lower(f."new_slug")
                          OR lower(b."data"->>'filename') = lower(f."new_slug")))
          OR EXISTS (SELECT 1 FROM pg_temp."ws_fold" o
                      WHERE o."type" = 'file' AND o."new_path" = f."new_path"
                        AND lower(o."new_slug") = lower(f."new_slug") AND o."node_id" < f."node_id"));
  SELECT count(*) INTO bad FROM pg_temp."ws_fold" f
   WHERE f."type" = 'file'
     AND (EXISTS (SELECT 1 FROM "public"."nodes" b
                   WHERE b."owner_id" = brain AND b."type" = 'file' AND b."path" = f."new_path"
                     AND (lower(b."slug") = lower(f."new_slug")
                          OR lower(b."data"->>'filename') = lower(f."new_slug")))
          OR EXISTS (SELECT 1 FROM pg_temp."ws_fold" o
                      WHERE o."type" = 'file' AND o."new_path" = f."new_path"
                        AND lower(o."new_slug") = lower(f."new_slug") AND o."node_id" <> f."node_id"));
  IF bad > 0 THEN
    RAISE EXCEPTION 'spaces fold: % file name(s) still taken in their folder; nothing written', bad
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO c FROM pg_temp."ws_fold" f
   WHERE f."new_path" <> f."old_path" OR f."new_slug" IS DISTINCT FROM f."old_slug";
  RETURN QUERY SELECT 'fold'::text, 'names made unique in the brain'::text, 'rows'::text, c;

  -- 4. The record, then the move. An UPDATE: no node_ingested notify.
  INSERT INTO "public"."space_fold_items"
         ("node_id", "space_id", "login_id", "node_type", "home_workspace_id", "grant_admin",
          "grant_team", "sharing", "deleted_at", "old_path", "new_path", "old_slug", "new_slug")
  SELECT f."node_id", f."space_id", f."login_id", f."type"::text, f."home", f."grant_admin",
         f."grant_team", f."sharing", f."deleted_at", f."old_path"::text, f."new_path"::text,
         f."old_slug", f."new_slug"
    FROM pg_temp."ws_fold" f
  ON CONFLICT ("node_id") DO NOTHING;
  -- Moving is not editing: updated_at stays (touch_updated_at, 0247).
  PERFORM set_config('mantle.keep_updated_at', 'on', true);
  -- Deepest first is not needed: the unique indexes are checked per row
  -- against rows already moved, and every new name is unique by step 3.
  UPDATE "public"."nodes" n
     SET "owner_id" = brain,
         "path" = f."new_path",
         "slug" = f."new_slug",
         "data" = coalesce(n."data", '{}'::jsonb)
                  || CASE WHEN f."type" <> 'branch' AND NOT f."embedded"
                          THEN jsonb_build_object('extract_skipped',
                                 jsonb_build_object('reason', 'spaces_fold', 'at', now()))
                          ELSE '{}'::jsonb END
                  -- Where the bytes stay: <spaces root>/<space id>/files/<node id>
                  -- (space-disk.ts); the brain's file readers look there. Its
                  -- name is the one step 3 made unique in its folder.
                  || CASE WHEN f."type" = 'file'
                          THEN jsonb_build_object('space_file', f."space_id"::text,
                                                  'filename', f."new_slug")
                          ELSE '{}'::jsonb END
                  -- In its author's trash at the fold: still there, marked.
                  || CASE WHEN f."deleted_at" IS NOT NULL
                          THEN jsonb_build_object('trashedBeforeFold', true,
                                                  'trashedAt', f."deleted_at")
                          ELSE '{}'::jsonb END
    FROM pg_temp."ws_fold" f
   WHERE n."id" = f."node_id";
  GET DIAGNOSTICS c = ROW_COUNT;
  PERFORM set_config('mantle.keep_updated_at', '', true);
  RETURN QUERY SELECT 'fold'::text, 'items'::text, 'moved into the brain'::text, c;
  SELECT coalesce(array_agg(f."node_id"), '{}'::uuid[]) INTO moved FROM pg_temp."ws_fold" f;

  -- What else names a personal space as its owner moves with it (an app's
  -- history, its database row, its access log, ...). The ledgers keyed by
  -- space_id (uploads, submissions) stay with the archived space.
  FOR t IN
    SELECT c2."table_name" AS tbl
      FROM information_schema.columns c2
      JOIN information_schema.tables t2
        ON t2."table_schema" = c2."table_schema" AND t2."table_name" = c2."table_name"
     WHERE c2."table_schema" = 'public' AND c2."column_name" = 'owner_id'
       AND t2."table_type" = 'BASE TABLE'
       AND c2."table_name" NOT IN ('nodes', 'spaces')
       AND c2."table_name" NOT LIKE 'archive\_%'
     ORDER BY 1
  LOOP
    EXECUTE format(
      'UPDATE "public".%I x SET "owner_id" = $1
        WHERE x."owner_id" IN (SELECT s."id" FROM "public"."spaces" s WHERE s."kind" = ''personal'')',
      t.tbl) USING brain;
    GET DIAGNOSTICS c = ROW_COUNT;
    IF c > 0 THEN
      RETURN QUERY SELECT 'fold'::text, t.tbl::text, 'rows moved with their items'::text, c;
    END IF;
  END LOOP;

  -- 5. The grants: exactly the home (Write off) and Admin and Team where the
  --    home row says so (Write off). The re-own and move triggers wrote a
  --    default home and folder rows; they are replaced.
  PERFORM set_config('mantle.acl_internal', 'on', true);
  DELETE FROM "public"."item_grants" g WHERE g."node_id" = ANY (moved);
  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "is_home")
  SELECT f."node_id", f."home", false, true FROM pg_temp."ws_fold" f
  ON CONFLICT ("node_id", "workspace_id") DO UPDATE
     SET "is_home" = true, "via_folder_id" = NULL, "excluded" = false, "write" = false;
  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write")
  SELECT f."node_id", admin_ws, false FROM pg_temp."ws_fold" f
   WHERE f."grant_admin" AND f."home" <> admin_ws
  ON CONFLICT ("node_id", "workspace_id") DO UPDATE
     SET "via_folder_id" = NULL, "excluded" = false, "write" = false;
  INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write")
  SELECT f."node_id", team_ws, false FROM pg_temp."ws_fold" f
   WHERE f."grant_team" AND team_ws IS NOT NULL AND f."home" <> team_ws
     AND "public"."mantle_grant_kind_ok"(f."type", team_ws)
  ON CONFLICT ("node_id", "workspace_id") DO UPDATE
     SET "via_folder_id" = NULL, "excluded" = false, "write" = false;
  -- Folder rows a moved folder passed to its moved children, for a
  -- workspace the child is not granted by its own row: none may stay.
  DELETE FROM "public"."item_grants" g
   USING pg_temp."ws_fold" f
   WHERE g."node_id" = f."node_id" AND NOT g."is_home"
     AND NOT (g."workspace_id" = admin_ws AND f."grant_admin")
     AND NOT (g."workspace_id" = team_ws AND f."grant_team");
  PERFORM "public"."mantle_acl_refresh"(moved);
  PERFORM set_config('mantle.acl_internal', '', true);
  SELECT count(*) INTO c FROM pg_temp."ws_fold" f WHERE f."grant_admin";
  RETURN QUERY SELECT 'grants'::text, 'Admin'::text, 'items'::text, c;
  SELECT count(*) INTO c FROM pg_temp."ws_fold" f WHERE f."grant_team";
  RETURN QUERY SELECT 'grants'::text, 'Team'::text, 'items'::text, c;

  -- 6. Archived, then the space_items rows go.
  INSERT INTO "public"."archive_spaces" ("id", "kind", "login_id", "orphaned_at", "created_at", "archived_at")
  SELECT s."id", s."kind", s."login_id", s."orphaned_at", s."created_at", now()
    FROM "public"."spaces" s WHERE s."kind" = 'personal'
  ON CONFLICT ("id") DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'archive'::text, 'spaces'::text, 'rows archived'::text, c;
  INSERT INTO "public"."archive_space_items"
         ("node_id", "author_login_id", "sharing", "review_state", "submitted_at",
          "submitted_version", "returned_note", "reviewed_by", "reviewed_at", "accepted_at",
          "created_at", "updated_at", "taken_by", "taken_at", "taken_root", "author_role",
          "taken_title", "deleted_at", "archived_at")
  SELECT si."node_id", si."author_login_id", si."sharing", si."review_state", si."submitted_at",
         si."submitted_version", si."returned_note", si."reviewed_by", si."reviewed_at", si."accepted_at",
         si."created_at", si."updated_at", si."taken_by", si."taken_at", si."taken_root", si."author_role",
         si."taken_title", si."deleted_at", now()
    FROM "public"."space_items" si
  ON CONFLICT ("node_id") DO NOTHING;
  -- An accepted row stays: it is its author's read path (member-accepted.ts)
  -- until the author's snapshot copy (S3) replaces it.
  DELETE FROM "public"."space_items" si
   WHERE si."review_state" <> 'accepted'
     AND EXISTS (SELECT 1 FROM "public"."archive_space_items" a WHERE a."node_id" = si."node_id");
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'cleared'::text, 'space_items'::text, 'rows deleted (archived)'::text, c;

  -- 7. The proof.
  SELECT count(*) INTO bad FROM "public"."mantle_ws_spaces_fold_check"() ck
   WHERE (ck."metric" IN ('items left in a personal space', 'kind roots left with children',
                          'space_items rows other than accepted', 'moved items without their home',
                          'personal spaces not archived',
                          'folded files sharing a name in their folder')
          AND ck."n" > 0);
  IF bad > 0 THEN
    RAISE EXCEPTION 'spaces fold: an item left in a space, a space_items row left, a home missing or a space not archived; nothing written'
      USING ERRCODE = '23514';
  END IF;
  -- Exactly the grants named: the home, Admin, Team, nothing else.
  SELECT count(*) INTO bad
    FROM pg_temp."ws_fold" f JOIN "public"."nodes" n ON n."id" = f."node_id"
   WHERE n."read_ws" IS DISTINCT FROM ARRAY(
           SELECT DISTINCT x FROM unnest(ARRAY[f."home"]
             || CASE WHEN f."grant_admin" THEN ARRAY[admin_ws] ELSE '{}'::uuid[] END
             || CASE WHEN f."grant_team" AND team_ws IS NOT NULL
                          AND "public"."mantle_grant_kind_ok"(f."type", team_ws)
                     THEN ARRAY[team_ws] ELSE '{}'::uuid[] END) x ORDER BY x)
      OR cardinality(n."write_ws") > 0
      OR n."owner_id" IS DISTINCT FROM brain;
  IF bad > 0 THEN
    RAISE EXCEPTION 'spaces fold: % moved item(s) with other grants than their home row names; nothing written', bad
      USING ERRCODE = '23514';
  END IF;
  -- Every author reaches every item of its space (its private workspace).
  SELECT count(*) INTO bad
    FROM pg_temp."ws_fold" f JOIN "public"."nodes" n ON n."id" = f."node_id"
    JOIN auth.users u ON u."id" = f."login_id"
   WHERE NOT EXISTS (SELECT 1 FROM "public"."workspace_users" wu
                       JOIN "public"."workspaces" w ON w."id" = wu."workspace_id" AND w."archived_at" IS NULL
                      WHERE wu."login_id" = f."login_id" AND wu."workspace_id" = ANY (n."read_ws"));
  RETURN QUERY SELECT 'proof'::text, 'items their author does not reach'::text, 'count'::text, bad;
  IF bad > 0 THEN
    RAISE EXCEPTION 'spaces fold: % moved item(s) their author cannot reach; nothing written', bad
      USING ERRCODE = '23514';
  END IF;
  -- No login reads a moved item it did not read before: its own space's
  -- items; an Admin user (role admin, or a user of the Admin workspace) the
  -- items 0264 grants Admin or Team (submitted, left behind, released; the
  -- team-shared drafts of active members and submitted client requests);
  -- a member the items it grants Team.
  SELECT count(*) INTO bad
    FROM pg_temp."ws_fold" f
    JOIN "public"."nodes" n ON n."id" = f."node_id"
    JOIN "public"."workspace_users" wu ON wu."workspace_id" = ANY (n."read_ws")
    JOIN "public"."workspaces" w ON w."id" = wu."workspace_id" AND w."archived_at" IS NULL
    JOIN auth.users u ON u."id" = wu."login_id"
   WHERE wu."login_id" IS DISTINCT FROM f."login_id"
     AND NOT ((u."role" = 'admin' OR EXISTS (SELECT 1 FROM "public"."workspace_users" a
                                              WHERE a."workspace_id" = admin_ws AND a."login_id" = u."id"))
              AND (f."grant_admin" OR f."grant_team"))
     AND NOT (u."role" = 'member' AND f."grant_team");
  RETURN QUERY SELECT 'proof'::text, 'logins reading a moved item they did not read before'::text,
                      'count'::text, bad;
  IF bad > 0 THEN
    RAISE EXCEPTION 'spaces fold: % read(s) of a moved item gained by a login that did not read it before; nothing written', bad
      USING ERRCODE = '23514';
  END IF;
  -- The assistants: what their workspace now holds of the moved items (the
  -- gains signed off in 9.3 and 18.13). Listed, not refused.
  RETURN QUERY
    SELECT 'reach'::text, 'assistant of ' || CASE WHEN r2."workspace_id" = admin_ws THEN 'Admin'
                                                  WHEN r2."workspace_id" = team_ws THEN 'Team'
                                                  ELSE 'another workspace' END,
           'moved items it now reads'::text, count(*)
      FROM "public"."workspace_resources" r2
      JOIN pg_temp."ws_fold" f ON true
      JOIN "public"."nodes" n ON n."id" = f."node_id" AND r2."workspace_id" = ANY (n."read_ws")
     WHERE r2."type" = 'assistant'
     GROUP BY 1, 2;
  -- No other grant changed.
  SELECT count(*)::text || ':' || coalesce(sum(hashtext(concat_ws('|', g."node_id", g."workspace_id",
           g."write", g."is_home", g."excluded", g."via_folder_id")))::text, '0')
    INTO grants_after
    FROM "public"."item_grants" g
   WHERE NOT (g."node_id" = ANY (moved));
  IF grants_after IS DISTINCT FROM grants_before THEN
    RAISE EXCEPTION 'spaces fold: a grant outside the moved items changed; nothing written'
      USING ERRCODE = '23514';
  END IF;
  RETURN QUERY SELECT 'proof'::text, 'grants outside the moved items'::text, 'unchanged'::text, 1::bigint;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_spaces_fold"() FROM PUBLIC;
--> statement-breakpoint

-- A brain switched later (21.9; a fresh install): 0264's body plus the fold.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_migrate"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY SELECT * FROM "public"."mantle_ws_migrate_bridged"();
  IF "public"."mantle_ws_skip_reason"() IS NOT NULL THEN RETURN; END IF;
  PERFORM "public"."mantle_ws_switch_off"();
  RETURN QUERY SELECT 'bridge off'::text, b."step", 'count'::text, b."n"
                 FROM "public"."mantle_ws_bridge_off"() b;
  RETURN QUERY SELECT * FROM "public"."mantle_ws_switch_guard"();
  -- The review states (0264) and the spaces fold (W6b): the fold runs
  -- mantle_ws_review_off() first.
  RETURN QUERY SELECT 'spaces fold: ' || r."section", r."subject", r."metric", r."n"
                 FROM "public"."mantle_ws_spaces_fold"() r;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate"() FROM PUBLIC;
--> statement-breakpoint

-- ── 3b. Snapshot copies: read only, stamped at their create ─────────────────
--
-- The author's snapshot copy of an accepted item (S3, snapshot-copies.ts) is
-- read only for everyone, its author included (CEO decision, W6b fix round
-- 1): data.snapshot_of marks it. Its author may delete it (its home's
-- Moderator, as any item); nobody edits it, moves it out of its private (or
-- Former user) workspace or shares it. The app refuses first (itemWriteGate,
-- the table, file and page writers); these triggers are the floor under
-- every path, an MCP tool or a script included. Only a verified migration
-- bypass (mantle_heads_bypass) passes.

-- Whether this transaction holds a verified migration bypass.
CREATE OR REPLACE FUNCTION "public"."mantle_bypass_verified"()
  RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  bypass text := coalesce(current_setting('mantle.heads_bypass', true), '');
BEGIN
  RETURN bypass <> '' AND position('|' IN bypass) > 0
     AND split_part(bypass, '|', 2)
         = "public"."mantle_heads_mac"('bypass:' || split_part(bypass, '|', 1));
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bypass_verified"() FROM PUBLIC;
--> statement-breakpoint
-- The item row: its title, slug, tags, kind, owner and data stay as made.
-- The keys the extractor and the thumbnails write about the bytes may
-- change (they describe, they do not edit); a move inside its home (path)
-- is the grant check's below.
CREATE OR REPLACE FUNCTION "public"."mantle_snapshot_copy_node_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  derived text[] := ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
                          'indexing_applied', 'summary', 'summary_model', 'summary_at',
                          'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
                          'schemaDigest'];
BEGIN
  IF NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."slug" IS DISTINCT FROM OLD."slug"
     OR NEW."tags" IS DISTINCT FROM OLD."tags"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
     OR (coalesce(NEW."data", '{}'::jsonb) - derived)
        IS DISTINCT FROM (coalesce(OLD."data", '{}'::jsonb) - derived) THEN
    IF "public"."mantle_bypass_verified"() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'not allowed to change this item: it is a read-only snapshot copy'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_snapshot_copy_node_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_snapshot_copy_read_only" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_snapshot_copy_read_only" BEFORE UPDATE ON "public"."nodes"
  FOR EACH ROW WHEN (OLD."data" ? 'snapshot_of')
  EXECUTE FUNCTION "public"."mantle_snapshot_copy_node_trg"();
--> statement-breakpoint
-- The content rows (a page's doc and draft, a drawing's scene and draft, a
-- table's data and draft): a change to a copy's is refused. A drawing's
-- rendered picture (scene_svg) and the text mirrors may be refreshed.
CREATE OR REPLACE FUNCTION "public"."mantle_snapshot_copy_content_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."nodes" n
              WHERE n."id" = OLD."node_id" AND n."data" ? 'snapshot_of')
     AND NOT "public"."mantle_bypass_verified"() THEN
    RAISE EXCEPTION 'not allowed to change this item: it is a read-only snapshot copy'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_snapshot_copy_content_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pages_snapshot_copy_read_only" ON "public"."pages";
--> statement-breakpoint
CREATE TRIGGER "pages_snapshot_copy_read_only" BEFORE UPDATE OF "doc", "draft_doc" ON "public"."pages"
  FOR EACH ROW
  WHEN (NEW."doc" IS DISTINCT FROM OLD."doc" OR NEW."draft_doc" IS DISTINCT FROM OLD."draft_doc")
  EXECUTE FUNCTION "public"."mantle_snapshot_copy_content_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "draws_snapshot_copy_read_only" ON "public"."draws";
--> statement-breakpoint
CREATE TRIGGER "draws_snapshot_copy_read_only" BEFORE UPDATE OF "scene", "draft_scene" ON "public"."draws"
  FOR EACH ROW
  WHEN (NEW."scene" IS DISTINCT FROM OLD."scene" OR NEW."draft_scene" IS DISTINCT FROM OLD."draft_scene")
  EXECUTE FUNCTION "public"."mantle_snapshot_copy_content_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "tables_snapshot_copy_read_only" ON "public"."tables";
--> statement-breakpoint
CREATE TRIGGER "tables_snapshot_copy_read_only"
  BEFORE UPDATE OF "data", "draft_data", "storage_path" ON "public"."tables"
  FOR EACH ROW
  WHEN (NEW."data" IS DISTINCT FROM OLD."data" OR NEW."draft_data" IS DISTINCT FROM OLD."draft_data"
        OR NEW."storage_path" IS DISTINCT FROM OLD."storage_path")
  EXECUTE FUNCTION "public"."mantle_snapshot_copy_content_trg"();
--> statement-breakpoint
-- Its grants: one home row, Write off, in a private or Former user
-- workspace. A grant to another workspace (a share, a folder's grant passed
-- on by a move into a shared folder), Write on, or a home elsewhere (a move
-- out) is refused. A "Removed here" row narrows: allowed.
CREATE OR REPLACE FUNCTION "public"."mantle_snapshot_copy_grant_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NEW."excluded"
     OR NOT EXISTS (SELECT 1 FROM "public"."nodes" n
                     WHERE n."id" = NEW."node_id" AND n."data" ? 'snapshot_of') THEN
    RETURN NEW;
  END IF;
  IF NEW."is_home" AND NOT NEW."write"
     AND (EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                   WHERE p."workspace_id" = NEW."workspace_id")
          OR EXISTS (SELECT 1 FROM "public"."former_user_workspaces" fw
                      WHERE fw."workspace_id" = NEW."workspace_id")) THEN
    RETURN NEW;
  END IF;
  IF "public"."mantle_bypass_verified"() THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'not allowed to share this item: it is a read-only snapshot copy in its private workspace'
    USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_snapshot_copy_grant_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "item_grants_snapshot_copy" ON "public"."item_grants";
--> statement-breakpoint
CREATE TRIGGER "item_grants_snapshot_copy" BEFORE INSERT OR UPDATE ON "public"."item_grants"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_snapshot_copy_grant_trg"();
--> statement-breakpoint
-- Its links (fix round 2, L-1): an open link or a contact share of a copy
-- would hand it to someone outside its private workspace. A live share row
-- (made, or moved onto a copy, or a revoked one reopened) is refused; a
-- revoke always passes.
CREATE OR REPLACE FUNCTION "public"."mantle_snapshot_copy_share_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NEW."revoked_at" IS NULL
     AND EXISTS (SELECT 1 FROM "public"."nodes" n
                  WHERE n."id" = NEW."node_id" AND n."data" ? 'snapshot_of')
     AND NOT "public"."mantle_bypass_verified"() THEN
    RAISE EXCEPTION 'not allowed to share this item: it is a read-only snapshot copy in its private workspace'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_snapshot_copy_share_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "shares_snapshot_copy" ON "public"."shares";
--> statement-breakpoint
CREATE TRIGGER "shares_snapshot_copy" BEFORE INSERT OR UPDATE OF "node_id", "revoked_at"
  ON "public"."shares"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_snapshot_copy_share_trg"();
--> statement-breakpoint
-- The create stamp (fix round 1, M4): a transaction that names one
-- (mantle.create_stamp, a json object, set by withSystemTx from the app's
-- CreateHome) merges it into the data of every item it makes, in the
-- insert itself, so a snapshot copy is never seen without its
-- data.snapshot_of and extract_skipped. Folders are structure: never.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_create_stamp_trg"()
  RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s text := coalesce(current_setting('mantle.create_stamp', true), '');
BEGIN
  IF s <> '' AND NEW."type" IS DISTINCT FROM 'branch'::node_type THEN
    NEW."data" := coalesce(NEW."data", '{}'::jsonb) || s::jsonb;
    -- A terminal skip holds while its time is at or after the row's last
    -- write (extractSkippedSql): stamped with the row's own time, never the
    -- app's clock from before the insert.
    IF NEW."data" ? 'extract_skipped' THEN
      NEW."data" := jsonb_set(NEW."data", '{extract_skipped,at}',
        to_jsonb(greatest(clock_timestamp(), coalesce(NEW."updated_at", now()))));
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_create_stamp" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_create_stamp" BEFORE INSERT ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_nodes_create_stamp_trg"();
--> statement-breakpoint

-- ── 3c. Who made a peer (W6b fix round 3, M-1) ──────────────────────────────
-- The login that registered a linked brain. An app_delete through a peer
-- bound to the owner is the owner's (purged after 30 days) only when the
-- owner made the peer too; any other peer's waits in the trash for the owner.
-- Peers made before this have none: the owner records itself when it binds
-- one to the owner again.
ALTER TABLE "public"."mantle_peers" ADD COLUMN IF NOT EXISTS "created_by" uuid
  REFERENCES "auth"."users"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- ── 4. Run it ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM "public"."mantle_ws_spaces_fold"() LOOP
    RAISE NOTICE '0267: % % % = %', r."section", r."subject", r."metric", r."n";
  END LOOP;
  FOR r IN SELECT * FROM "public"."mantle_ws_spaces_fold_check"() LOOP
    RAISE NOTICE '0267 check: % = %', r."metric", r."n";
  END LOOP;
END
$$;
