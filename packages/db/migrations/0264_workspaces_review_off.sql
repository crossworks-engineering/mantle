-- Workspaces W5c: review states resolved without loss (plan page 4887b8e7,
-- sections 9.3 and 9.5). The review routes and their UI are gone in W5c;
-- what they left in the tables is settled here, once.
--
-- 1. Archive, never drop: every row of space_items, space_submissions and
--    space_item_bundles is copied to archive_space_items,
--    archive_space_submissions and archive_space_item_bundles before any
--    change (with archived_at).
-- 2. The home of every space item is RECORDED, not granted. Personal items
--    stay in their spaces until W6b, and item_grants refuses a node a
--    personal space owns (0244 rule 2), so no grant is written here.
--    space_item_homes says, per item, the workspace W6b homes it in and
--    the grants W6b writes (9.3):
--     - home: the private workspace of the login whose space holds it,
--       "<name> (only you)" (that login its only user, a Moderator;
--       private_workspaces); for an accepted item (a brain item already)
--       its author's, where W6b puts the author's snapshot copy (S3). A
--       space with no login (the login was deleted) gets a workspace with
--       no users, "Former user" (former_user_workspaces); so does an
--       accepted item whose author is gone.
--     - grant_admin: submitted (an item in a submitted bundle counts), or
--       left behind (team-shared draft or returned, its login gone or
--       disabled).
--     - grant_team: team-shared draft, returned or submitted of an active
--       member, or a submitted client request (Admin and Team, never a
--       client workspace).
--     - accepted, taken (in the admin's own space) and trashed items: no
--       grants.
--    write is always false (Write off, 9.3).
-- 3. The states resolve: submitted, returned and taken become draft, and
--    the review columns are cleared (their values are in the archive).
--    Sharing, accepted rows, the trash (deleted_at), every node, file, app,
--    app row and app-db file are untouched. Then the rows of
--    space_submissions and space_item_bundles go (archived first).
--
-- All of it is mantle_ws_review_off(): idempotent (a second run changes
-- nothing), fine on an empty brain, and it raises 23514 when an item is
-- left without a home on a brain with workspaces, a state or a bundle is
-- left, a row is not archived, or a grant or an item's reach changed. A
-- brain NOT on workspaces (clients present, 21.9, or no anchor yet) is
-- archived and resolved now (the routes are gone for it too); its homes are
-- written when it switches: mantle_ws_migrate runs mantle_ws_review_off()
-- at its end. The homes come from the archive, so the states resolved
-- today still decide them then.
--
-- No grant, no node write, no LLM work, no extractor notify, no queue row.
-- The space_items triggers that fire are notify-only (needs_you_changed).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ── 1. The archives ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."archive_space_items" (LIKE "public"."space_items");
--> statement-breakpoint
ALTER TABLE "public"."archive_space_items"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_space_submissions" (LIKE "public"."space_submissions");
--> statement-breakpoint
ALTER TABLE "public"."archive_space_submissions"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_space_item_bundles" (LIKE "public"."space_item_bundles");
--> statement-breakpoint
ALTER TABLE "public"."archive_space_item_bundles"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
-- A key only, so a second run copies nothing twice. No foreign key: an
-- archive row outlives its node, its login and its space.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'archive_space_items_pkey') THEN
    ALTER TABLE "public"."archive_space_items" ADD PRIMARY KEY ("node_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'archive_space_submissions_pkey') THEN
    ALTER TABLE "public"."archive_space_submissions" ADD PRIMARY KEY ("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'archive_space_item_bundles_pkey') THEN
    ALTER TABLE "public"."archive_space_item_bundles" ADD PRIMARY KEY ("root_id", "node_id");
  END IF;
END
$$;
--> statement-breakpoint

-- ── 2. The recorded homes ────────────────────────────────────────────────────

-- The private workspace of a login: "<name> (only you)", the login its only
-- user and a Moderator. Not a built-in workspace (bridge_key stays NULL).
CREATE TABLE IF NOT EXISTS "public"."private_workspaces" (
  "login_id" uuid PRIMARY KEY REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL UNIQUE REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The "Former user" workspace (no users) of a personal space whose login is
-- gone. space_id is the space (the brain id for accepted items whose author
-- is gone); no foreign key: the record outlives a purged space.
CREATE TABLE IF NOT EXISTS "public"."former_user_workspaces" (
  "space_id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL UNIQUE REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One row per space item: its home and the grants W6b writes (9.3), with
-- the state, sharing and author role it had before 0264.
CREATE TABLE IF NOT EXISTS "public"."space_item_homes" (
  "node_id" uuid PRIMARY KEY REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "home_workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id"),
  "grant_admin" boolean NOT NULL DEFAULT false,
  "grant_team" boolean NOT NULL DEFAULT false,
  "write" boolean NOT NULL DEFAULT false,
  "state_before" text NOT NULL,
  "sharing_before" text NOT NULL,
  "author_role" text,
  "resolved_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_item_homes_home_idx"
  ON "public"."space_item_homes" ("home_workspace_id");
--> statement-breakpoint
-- Admin pool and definer functions only (access-matrix.ts): no limited role
-- holds a grant, and row security is on with no policy.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['archive_space_items', 'archive_space_submissions',
                           'archive_space_item_bundles', 'private_workspaces',
                           'former_user_workspaces', 'space_item_homes'] LOOP
    EXECUTE format('ALTER TABLE "public".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON "public".%I FROM PUBLIC', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── 3. The check ─────────────────────────────────────────────────────────────

-- Numbers only. A brain with workspaces is done when every space item has a
-- home; every brain is done when nothing is left unarchived, no item is
-- still submitted, returned or taken, and no submission or bundle row is
-- left.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_review_homes_check"()
  RETURNS TABLE ("metric" text, "n" bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT 'space_items rows', count(*) FROM "public"."space_items"
  UNION ALL
  SELECT 'homes', count(*) FROM "public"."space_item_homes"
  UNION ALL
  SELECT 'items without a home', count(*) FROM "public"."space_items" si
   WHERE NOT EXISTS (SELECT 1 FROM "public"."space_item_homes" h WHERE h."node_id" = si."node_id")
  UNION ALL
  SELECT 'homes granting Admin', count(*) FROM "public"."space_item_homes" h WHERE h."grant_admin"
  UNION ALL
  SELECT 'homes granting Team', count(*) FROM "public"."space_item_homes" h WHERE h."grant_team"
  UNION ALL
  SELECT 'archive rows: space_items', count(*) FROM "public"."archive_space_items"
  UNION ALL
  SELECT 'archive rows: space_submissions', count(*) FROM "public"."archive_space_submissions"
  UNION ALL
  SELECT 'archive rows: space_item_bundles', count(*) FROM "public"."archive_space_item_bundles"
  UNION ALL
  SELECT 'rows not archived', (
    (SELECT count(*) FROM "public"."space_items" si
      WHERE NOT EXISTS (SELECT 1 FROM "public"."archive_space_items" a WHERE a."node_id" = si."node_id"))
    + (SELECT count(*) FROM "public"."space_submissions" s
        WHERE NOT EXISTS (SELECT 1 FROM "public"."archive_space_submissions" a WHERE a."id" = s."id"))
    + (SELECT count(*) FROM "public"."space_item_bundles" b
        WHERE NOT EXISTS (SELECT 1 FROM "public"."archive_space_item_bundles" a
                           WHERE a."root_id" = b."root_id" AND a."node_id" = b."node_id")))
  UNION ALL
  SELECT 'items still submitted, returned or taken', count(*) FROM "public"."space_items" si
   WHERE si."review_state" IN ('submitted', 'returned', 'taken')
  UNION ALL
  SELECT 'open submissions', count(*) FROM "public"."space_submissions"
  UNION ALL
  SELECT 'bundles', count(*) FROM "public"."space_item_bundles"
  UNION ALL
  SELECT 'private workspaces', count(*) FROM "public"."private_workspaces"
  UNION ALL
  SELECT 'former user workspaces', count(*) FROM "public"."former_user_workspaces"
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_review_homes_check"() FROM PUBLIC;
--> statement-breakpoint

-- ── 4. The work ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."mantle_ws_review_off"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  admin_ws uuid;
  r record;
  ws uuid;
  c bigint;
  grants_before text;
  reach_before text;
  grants_after text;
  reach_after text;
  missing bigint;
  left_states bigint;
  open_subs bigint;
  open_bundles bigint;
  not_archived bigint;
BEGIN
  IF brain IS NOT NULL THEN
    SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
     WHERE w."owner_id" = brain AND w."is_admin";
  END IF;
  -- No writer between the copy and the change (the routes are gone, an old
  -- server may still be up during a roll).
  LOCK TABLE "public"."space_items", "public"."space_submissions",
             "public"."space_item_bundles" IN EXCLUSIVE MODE;
  -- What this function must not change: every grant and every item's reach.
  SELECT count(*)::text || ':' || coalesce(sum(hashtext(concat_ws('|', g."node_id", g."workspace_id",
           g."write", g."is_home", g."excluded", g."via_folder_id")))::text, '0')
    INTO grants_before FROM "public"."item_grants" g;
  SELECT count(*)::text || ':' || coalesce(sum(hashtext(concat_ws('|', x."id", x."read_ws",
           x."write_ws", x."home_ws")))::text, '0')
    INTO reach_before FROM "public"."nodes" x;

  -- 1. Archive every row first.
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
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'archive'::text, 'space_items'::text, 'rows archived'::text, c;
  INSERT INTO "public"."archive_space_submissions" ("id", "space_id", "node_id", "created_at", "archived_at")
  SELECT s."id", s."space_id", s."node_id", s."created_at", now() FROM "public"."space_submissions" s
  ON CONFLICT ("id") DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'archive'::text, 'space_submissions'::text, 'rows archived'::text, c;
  INSERT INTO "public"."archive_space_item_bundles" ("root_id", "node_id", "position", "archived_at")
  SELECT b."root_id", b."node_id", b."position", now() FROM "public"."space_item_bundles" b
  ON CONFLICT ("root_id", "node_id") DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'archive'::text, 'space_item_bundles'::text, 'rows archived'::text, c;

  -- 2. The homes, on a brain with workspaces. The state, sharing and role
  --    an item had come from its archive row (a later run, at the switch
  --    of a brain set up by hand, still sees them); the trash is today's.
  IF admin_ws IS NOT NULL THEN
    CREATE TEMP TABLE IF NOT EXISTS "ws_review_items" (
      "node_id" uuid PRIMARY KEY, "state" text, "sharing" text, "author_role" text,
      "trashed" boolean, "personal" boolean, "space_login" uuid, "home_login" uuid,
      "former_key" uuid) ON COMMIT DROP;
    TRUNCATE "ws_review_items";
    INSERT INTO "ws_review_items"
    SELECT si."node_id",
           coalesce(a."review_state", si."review_state"),
           coalesce(a."sharing", si."sharing"),
           coalesce(a."author_role", si."author_role"),
           si."deleted_at" IS NOT NULL,
           coalesce(s."kind" = 'personal', false),
           CASE WHEN s."kind" = 'personal' THEN s."login_id" END,
           CASE WHEN s."kind" = 'personal' THEN s."login_id" ELSE si."author_login_id" END,
           CASE WHEN s."kind" = 'personal' THEN s."id" ELSE brain END
      FROM "public"."space_items" si
      JOIN "public"."nodes" n ON n."id" = si."node_id"
      LEFT JOIN "public"."spaces" s ON s."id" = n."owner_id"
      LEFT JOIN "public"."archive_space_items" a ON a."node_id" = si."node_id"
     WHERE NOT EXISTS (SELECT 1 FROM "public"."space_item_homes" h WHERE h."node_id" = si."node_id");

    -- The private workspaces still missing.
    c := 0;
    FOR r IN
      SELECT DISTINCT i."home_login" AS login,
             left(coalesce(nullif(btrim(u."display_name"), ''), split_part(u."email", '@', 1)), 100) AS label
        FROM "ws_review_items" i
        JOIN auth.users u ON u."id" = i."home_login"
       WHERE NOT EXISTS (SELECT 1 FROM "public"."private_workspaces" p WHERE p."login_id" = i."home_login")
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
      c := c + 1;
    END LOOP;
    RETURN QUERY SELECT 'homes'::text, 'private workspaces'::text, 'made'::text, c;

    -- The "Former user" workspaces still missing (no users).
    c := 0;
    FOR r IN
      SELECT DISTINCT i."former_key" AS space
        FROM "ws_review_items" i
       WHERE i."home_login" IS NULL AND i."former_key" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f WHERE f."space_id" = i."former_key")
       ORDER BY 1
    LOOP
      INSERT INTO "public"."workspaces" ("owner_id", "name", "description")
      VALUES (brain, 'Former user', 'The work of a login that was removed. It has no users; an Admin user may join it.')
      RETURNING "id" INTO ws;
      INSERT INTO "public"."former_user_workspaces" ("space_id", "workspace_id") VALUES (r.space, ws);
      INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
      VALUES (ws, NULL, 'review_off.former', '{}'::jsonb);
      c := c + 1;
    END LOOP;
    RETURN QUERY SELECT 'homes'::text, 'former user workspaces'::text, 'made'::text, c;

    -- The homes and the grants W6b writes (9.3).
    INSERT INTO "public"."space_item_homes"
           ("node_id", "home_workspace_id", "grant_admin", "grant_team", "write",
            "state_before", "sharing_before", "author_role", "resolved_at")
    SELECT x."node_id", coalesce(p."workspace_id", f."workspace_id"),
           x.open AND (x.submitted OR x.left_behind),
           x.open AND ((x."sharing" = 'team' AND (x."state" IN ('draft', 'returned') OR x.submitted)
                        AND x."author_role" = 'member' AND x.active_member)
                       OR (x."author_role" = 'client' AND x.submitted)),
           false, x."state", x."sharing", x."author_role", now()
      FROM (
        SELECT i.*,
               i."state" NOT IN ('accepted', 'taken') AND NOT i."trashed" AS open,
               i."state" = 'submitted' OR EXISTS (
                 SELECT 1 FROM "public"."archive_space_item_bundles" b
                   JOIN "public"."archive_space_items" root ON root."node_id" = b."root_id"
                  WHERE b."node_id" = i."node_id" AND root."review_state" = 'submitted') AS submitted,
               i."personal" AND i."sharing" = 'team' AND i."state" IN ('draft', 'returned')
                 AND (u."id" IS NULL OR u."disabled_at" IS NOT NULL) AS left_behind,
               i."personal" AND coalesce(u."role" = 'member' AND u."disabled_at" IS NULL, false) AS active_member
          FROM "ws_review_items" i
          LEFT JOIN auth.users u ON u."id" = i."space_login") x
      LEFT JOIN "public"."private_workspaces" p ON p."login_id" = x."home_login"
      LEFT JOIN "public"."former_user_workspaces" f
        ON x."home_login" IS NULL AND f."space_id" = x."former_key";
    RETURN QUERY
      SELECT 'homes'::text,
             CASE WHEN EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                                WHERE p."workspace_id" = h."home_workspace_id")
                  THEN 'private' ELSE 'former user' END
               || ', ' || h."state_before" || CASE WHEN h."sharing_before" = 'team' THEN ' (team-shared)' ELSE '' END,
             'recorded' || CASE WHEN h."grant_admin" THEN ', grant Admin' ELSE '' END
                        || CASE WHEN h."grant_team" THEN ', grant Team' ELSE '' END,
             count(*)
        FROM "public"."space_item_homes" h
        JOIN "ws_review_items" i ON i."node_id" = h."node_id"
       GROUP BY 2, 3;
  END IF;

  -- 3. The states resolve: submitted, returned and taken become draft; the
  --    review columns clear. Accepted rows, sharing and the trash stay.
  CREATE TEMP TABLE IF NOT EXISTS "ws_review_resolve" ("node_id" uuid PRIMARY KEY, "was" text)
    ON COMMIT DROP;
  TRUNCATE "ws_review_resolve";
  INSERT INTO "ws_review_resolve"
  SELECT si."node_id", si."review_state" FROM "public"."space_items" si
   WHERE si."review_state" <> 'accepted'
     AND (si."review_state" <> 'draft'
          OR si."submitted_at" IS NOT NULL OR si."submitted_version" IS NOT NULL
          OR si."returned_note" IS NOT NULL OR si."reviewed_by" IS NOT NULL
          OR si."reviewed_at" IS NOT NULL OR si."taken_by" IS NOT NULL
          OR si."taken_at" IS NOT NULL OR si."taken_root" IS NOT NULL
          OR si."taken_title" IS NOT NULL);
  UPDATE "public"."space_items" si
     SET "review_state" = 'draft', "submitted_at" = NULL, "submitted_version" = NULL,
         "returned_note" = NULL, "reviewed_by" = NULL, "reviewed_at" = NULL,
         "taken_by" = NULL, "taken_at" = NULL, "taken_root" = NULL, "taken_title" = NULL,
         "updated_at" = now()
    FROM "ws_review_resolve" x
   WHERE si."node_id" = x."node_id";
  RETURN QUERY
    SELECT 'states'::text, x."was", 'resolved to draft'::text, count(*)
      FROM "ws_review_resolve" x GROUP BY x."was";

  DELETE FROM "public"."space_item_bundles" b
   USING "public"."archive_space_item_bundles" a
   WHERE a."root_id" = b."root_id" AND a."node_id" = b."node_id";
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'cleared'::text, 'space_item_bundles'::text, 'rows deleted (archived)'::text, c;
  DELETE FROM "public"."space_submissions" s
   USING "public"."archive_space_submissions" a
   WHERE a."id" = s."id";
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'cleared'::text, 'space_submissions'::text, 'rows deleted (archived)'::text, c;

  -- 4. Done, or nothing is written (23514).
  SELECT ck."n" INTO missing FROM "public"."mantle_ws_review_homes_check"() ck
   WHERE ck."metric" = 'items without a home';
  SELECT ck."n" INTO left_states FROM "public"."mantle_ws_review_homes_check"() ck
   WHERE ck."metric" = 'items still submitted, returned or taken';
  SELECT ck."n" INTO open_subs FROM "public"."mantle_ws_review_homes_check"() ck
   WHERE ck."metric" = 'open submissions';
  SELECT ck."n" INTO open_bundles FROM "public"."mantle_ws_review_homes_check"() ck
   WHERE ck."metric" = 'bundles';
  SELECT ck."n" INTO not_archived FROM "public"."mantle_ws_review_homes_check"() ck
   WHERE ck."metric" = 'rows not archived';
  IF left_states > 0 OR open_subs > 0 OR open_bundles > 0 OR not_archived > 0
     OR (admin_ws IS NOT NULL AND missing > 0) THEN
    RAISE EXCEPTION 'review off: % item(s) without a home, % still in review, % submission(s), % bundle row(s), % row(s) not archived; nothing written',
      CASE WHEN admin_ws IS NULL THEN 0 ELSE missing END, left_states, open_subs, open_bundles, not_archived
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::text || ':' || coalesce(sum(hashtext(concat_ws('|', g."node_id", g."workspace_id",
           g."write", g."is_home", g."excluded", g."via_folder_id")))::text, '0')
    INTO grants_after FROM "public"."item_grants" g;
  SELECT count(*)::text || ':' || coalesce(sum(hashtext(concat_ws('|', x."id", x."read_ws",
           x."write_ws", x."home_ws")))::text, '0')
    INTO reach_after FROM "public"."nodes" x;
  IF grants_after IS DISTINCT FROM grants_before OR reach_after IS DISTINCT FROM reach_before THEN
    RAISE EXCEPTION 'review off: a grant or an item''s reach changed; nothing written'
      USING ERRCODE = '23514';
  END IF;
  RETURN QUERY SELECT 'proof'::text, 'grants and item reach'::text, 'unchanged'::text, 1::bigint;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_review_off"() FROM PUBLIC;
--> statement-breakpoint

-- A brain switched later (a client box set up by hand, 21.9; a fresh
-- install): 0261's switch, then the review homes. The body is 0261's plus
-- the last line.
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
  -- The review states (0264): the homes of the space items, recorded.
  RETURN QUERY SELECT 'review off: ' || r."section", r."subject", r."metric", r."n"
                 FROM "public"."mantle_ws_review_off"() r;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_migrate"() FROM PUBLIC;
--> statement-breakpoint

-- ── 5. Run it ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r record;
  why text := "public"."mantle_ws_skip_reason"();
BEGIN
  FOR r IN SELECT * FROM "public"."mantle_ws_review_off"() LOOP
    RAISE NOTICE '0264: % % % = %', r."section", r."subject", r."metric", r."n";
  END LOOP;
  FOR r IN SELECT * FROM "public"."mantle_ws_review_homes_check"() LOOP
    RAISE NOTICE '0264 check: % = %', r."metric", r."n";
  END LOOP;
  IF why IS NOT NULL THEN
    RAISE NOTICE '0264: this brain is not on workspaces (%): review states resolved and archived; the homes are recorded when it switches (mantle_ws_migrate)', why;
    RETURN;
  END IF;
  -- The switch proof (0261) as a report. It compares the grants with the
  -- levels frozen at the switch, so on a brain used since its switch a
  -- grant given by hand, or an item placed in a shared folder, counts as
  -- gained there. That is not this migration's doing: mantle_ws_review_off
  -- proved above that no grant and no item's reach changed (23514
  -- otherwise), so a refusal here is reported, not raised.
  BEGIN
    FOR r IN SELECT * FROM "public"."mantle_ws_switch_guard"() LOOP
      RAISE NOTICE '0264 proof: % % % = %', r."section", r."subject", r."metric", r."n";
    END LOOP;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '0264 proof: the switch guard counts reads gained since the switch (%); 0264 changed no grant and no reach', SQLERRM;
  END;
END
$$;
