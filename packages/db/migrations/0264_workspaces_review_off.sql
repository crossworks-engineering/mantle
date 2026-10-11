-- Workspaces W5c: review states resolved without loss (plan page 4887b8e7,
-- sections 9.3 and 9.5). The review routes and their UI are gone in W5c;
-- what they left in the tables is settled here, once.
--
-- 1. Archive, never drop: every row of space_items, space_submissions and
--    space_item_bundles is copied to archive_space_items,
--    archive_space_submissions and archive_space_item_bundles before any
--    change (the same columns, no foreign key, plus archived_at).
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
--       no users, "Former user" (former_user_workspaces), one per former
--       user: keyed by the former login's id while an archive row still
--       names it, else by its personal space (one per login); so does an
--       accepted item whose author is gone. An accepted item whose author
--       was erased before 0264 archived it (no trace of who wrote it) gets
--       no Former user workspace: its home is the one it has now in the
--       brain (S3 has no author to copy it for).
--     - snapshot: true only for an accepted item whose home is a private or
--       Former user workspace; W6b makes the author's snapshot copy (S3)
--       there and for no other row. An accepted item kept in a brain
--       workspace (Admin, Team or any other) gets no copy at all: the item
--       is already in its home. Every run sets the flag by that rule, a
--       check keeps it off any item that was not accepted, and the run
--       raises 23514 should one point at any other workspace.
--     - homes are kept current: a login deleted after its private
--       workspace was made takes its private_workspaces row with it
--       (cascade). The next run turns that workspace into the login's
--       "Former user" workspace (renamed, the name gone; keyed by the login
--       id the workspace was made for; the name and description the user
--       gave it are also taken out of its earlier workspace_events, so no
--       name survives there), and any item whose home is no
--       longer a registered private or Former user workspace moves to the
--       Former user workspace of its former login.
--     - grant_admin: submitted (an item in a submitted bundle counts), or
--       left behind (team-shared draft or returned of a member or client
--       login now gone or disabled; never an admin's own item), or taken
--       by an admin who can no longer act on it (disabled, deleted or no
--       longer an admin: the old review queue's "released" rule), so it is
--       not stranded in that login's private workspace.
--     - grant_team: team-shared draft, returned or submitted of an active
--       member, or a submitted client request (Admin and Team, never a
--       client workspace).
--     - accepted, taken (by an admin who still is one) and trashed items:
--       no grants.
--    write is always false (Write off, 9.3).
--    The grants come from the state before 0264 (the archive) and from
--    what is live: sharing, the trash and the logins. App sharing and the
--    app trash still change until W6b (the member's my-apps routes, MCP
--    my_app_unshare, a promotion), so every run refreshes grant_admin and
--    grant_team of the homes already recorded; W6b applies the same rule
--    when it moves the items (W5c contract).
-- 3. The states resolve: submitted, returned and taken become draft, and
--    the review columns are cleared (their values are in the archive).
--    Sharing, accepted rows, the trash (deleted_at), every node, file, app,
--    app row and app-db file are untouched. Then the rows of
--    space_submissions and space_item_bundles go (archived first).
--
-- All of it is mantle_ws_review_off(): idempotent (a second run with
-- nothing changed changes nothing), fine on an empty brain, and it raises 23514 when an item is
-- left without a home on a brain with workspaces, a state or a bundle is
-- left, a row is not archived, a snapshot copy points outside a private or
-- Former user workspace, or a grant or an item's reach changed. A
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

-- The columns of each source table (types and NOT NULLs), no foreign key
-- and no check, plus archived_at; a key only, so a second run copies
-- nothing twice. Spelled out, not LIKE: on Postgres 18 LIKE copies the
-- source's NOT NULL constraint names, and a dump then restores the archive
-- first and the source table with renamed constraints.
CREATE TABLE IF NOT EXISTS "public"."archive_space_items" (
  "node_id"           uuid PRIMARY KEY,
  "author_login_id"   uuid,
  "sharing"           text NOT NULL,
  "review_state"      text NOT NULL,
  "submitted_at"      timestamptz,
  "submitted_version" integer,
  "returned_note"     text,
  "reviewed_by"       uuid,
  "reviewed_at"       timestamptz,
  "accepted_at"       timestamptz,
  "created_at"        timestamptz NOT NULL,
  "updated_at"        timestamptz NOT NULL,
  "taken_by"          uuid,
  "taken_at"          timestamptz,
  "taken_root"        uuid,
  "author_role"       text,
  "taken_title"       text,
  "deleted_at"        timestamptz,
  "archived_at"       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_space_submissions" (
  "id"          uuid PRIMARY KEY,
  "space_id"    uuid NOT NULL,
  "node_id"     uuid NOT NULL,
  "created_at"  timestamptz NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_space_item_bundles" (
  "root_id"     uuid NOT NULL,
  "node_id"     uuid NOT NULL,
  "position"    integer NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("root_id", "node_id")
);
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
-- The "Former user" workspace (no users) of a login that is gone, one per
-- former user. former_key is the former login's id while an archive row
-- (or the event that made its private workspace) still names it, else its
-- personal space's id (one space per login). An accepted item with no
-- trace of its author gets none (it keeps its brain home). No foreign key:
-- the record outlives the login and a purged space.
CREATE TABLE IF NOT EXISTS "public"."former_user_workspaces" (
  "former_key" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL UNIQUE REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One row per space item: its home and the grants W6b writes (9.3), with
-- the state, sharing and author role it had before 0264. snapshot: W6b
-- makes the author's snapshot copy of this accepted item in its home (S3);
-- true only when that home is a private or Former user workspace.
CREATE TABLE IF NOT EXISTS "public"."space_item_homes" (
  "node_id" uuid PRIMARY KEY REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "home_workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id"),
  "grant_admin" boolean NOT NULL DEFAULT false,
  "grant_team" boolean NOT NULL DEFAULT false,
  "write" boolean NOT NULL DEFAULT false,
  "state_before" text NOT NULL,
  "sharing_before" text NOT NULL,
  "author_role" text,
  "snapshot" boolean NOT NULL DEFAULT false,
  "resolved_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "space_item_homes_snapshot_accepted_ck" CHECK (NOT "snapshot" OR "state_before" = 'accepted')
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
  SELECT 'homes with a snapshot copy', count(*) FROM "public"."space_item_homes" h WHERE h."snapshot"
  UNION ALL
  SELECT 'snapshot homes outside a private or Former user workspace', count(*)
    FROM "public"."space_item_homes" h
   WHERE h."snapshot"
     AND NOT EXISTS (SELECT 1 FROM "public"."private_workspaces" p WHERE p."workspace_id" = h."home_workspace_id")
     AND NOT EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f WHERE f."workspace_id" = h."home_workspace_id")
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
  stray_snapshots bigint;
  scrubbed bigint := 0;
  scrub_n bigint;
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

  -- 2. The homes, on a brain with workspaces. The state an item had (and
  --    its role, the bundle it was submitted in, who took it) come from its
  --    archive row, so a later run (at the switch of a brain set up by hand)
  --    still sees them; sharing, the trash and the logins are today's. Every
  --    space item is looked at: a new one gets its home, one recorded before
  --    gets its grants refreshed (app sharing and the app trash still change
  --    until W6b), and its home moved when that home is no longer a
  --    registered private or Former user workspace.
  IF admin_ws IS NOT NULL THEN
    -- Private workspaces whose login was deleted since they were made
    -- (private_workspaces went with the login, ON DELETE CASCADE): each
    -- becomes that login's "Former user" workspace, keyed by the login id
    -- the event that made it names, and is renamed so no name is left.
    -- Should that login have a Former user workspace already (homes are not
    -- made that way, a hand edit could), the orphan is renamed and archived
    -- and its items move below.
    c := 0;
    FOR r IN
      SELECT DISTINCT ON (w."id") w."id" AS ws, (e."subject"->>'login')::uuid AS former
        FROM "public"."workspace_events" e
        JOIN "public"."workspaces" w ON w."id" = e."workspace_id"
       WHERE e."action" = 'review_off.private' AND e."subject" ? 'login' AND w."owner_id" = brain
         AND NOT EXISTS (SELECT 1 FROM "public"."private_workspaces" p WHERE p."workspace_id" = w."id")
         AND NOT EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f WHERE f."workspace_id" = w."id")
         AND NOT EXISTS (SELECT 1 FROM "public"."workspace_events" e2
                          WHERE e2."workspace_id" = w."id" AND e2."action" = 'review_off.former_renamed')
       ORDER BY w."id", e."at"
    LOOP
      UPDATE "public"."workspaces"
         SET "name" = 'Former user',
             "description" = 'The work of a login that was removed. It has no users; an Admin user may join it.',
             "updated_at" = now()
       WHERE "id" = r.ws;
      -- The name and description the user gave it (workspace.create and
      -- workspace.update events) go from its earlier events too.
      UPDATE "public"."workspace_events"
         SET "subject" = "subject" - 'name' - 'description'
       WHERE "workspace_id" = r.ws AND "subject" ?| ARRAY['name', 'description'];
      GET DIAGNOSTICS scrub_n = ROW_COUNT;
      scrubbed := scrubbed + scrub_n;
      IF NOT EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f WHERE f."former_key" = r.former) THEN
        INSERT INTO "public"."former_user_workspaces" ("former_key", "workspace_id") VALUES (r.former, r.ws);
        INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
        VALUES (r.ws, NULL, 'review_off.former', '{}'::jsonb);
      ELSE
        UPDATE "public"."workspaces" SET "archived_at" = coalesce("archived_at", now()) WHERE "id" = r.ws;
        INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
        VALUES (r.ws, NULL, 'review_off.former_renamed', '{}'::jsonb);
      END IF;
      c := c + 1;
    END LOOP;
    RETURN QUERY SELECT 'homes'::text, 'private workspaces of removed logins'::text,
                        'made Former user'::text, c;
    RETURN QUERY SELECT 'homes'::text, 'events of those workspaces'::text,
                        'name and description removed'::text, scrubbed;

    IF to_regclass('pg_temp.ws_review_items') IS NULL THEN
      CREATE TEMP TABLE pg_temp."ws_review_items" (
        "node_id" uuid PRIMARY KEY, "state" text, "sharing" text, "sharing_before" text,
        "author_role" text, "trashed" boolean, "personal" boolean, "space_login" uuid,
        "home_login" uuid, "former_key" uuid, "kept_home" uuid, "taken_by" uuid,
        "fresh" boolean, "stranded" boolean NOT NULL DEFAULT false) ON COMMIT DROP;
    END IF;
    TRUNCATE pg_temp."ws_review_items";
    INSERT INTO pg_temp."ws_review_items"
    SELECT si."node_id",
           coalesce(a."review_state", si."review_state"),
           si."sharing",
           coalesce(a."sharing", si."sharing"),
           coalesce(a."author_role", si."author_role"),
           si."deleted_at" IS NOT NULL,
           coalesce(s."kind" = 'personal', false),
           CASE WHEN s."kind" = 'personal' THEN s."login_id" END,
           CASE WHEN s."kind" = 'personal' THEN s."login_id" ELSE si."author_login_id" END,
           -- One Former user workspace per former user (used only when the
           -- login is gone): the login's id while the archive names it,
           -- else its personal space (one per login). An accepted item with
           -- no trace of its author has none.
           CASE WHEN s."kind" = 'personal' THEN coalesce(sib."login", s."id")
                ELSE coalesce(a."author_login_id", si."author_login_id") END,
           -- That accepted item keeps the home it has in the brain now.
           CASE WHEN s."kind" IS DISTINCT FROM 'personal'
                     AND coalesce(a."author_login_id", si."author_login_id") IS NULL
                THEN coalesce((SELECT g."workspace_id" FROM "public"."item_grants" g
                                WHERE g."node_id" = si."node_id" AND g."is_home"), admin_ws) END,
           coalesce(a."taken_by", si."taken_by"),
           NOT EXISTS (SELECT 1 FROM "public"."space_item_homes" h WHERE h."node_id" = si."node_id"),
           false
      FROM "public"."space_items" si
      JOIN "public"."nodes" n ON n."id" = si."node_id"
      LEFT JOIN "public"."spaces" s ON s."id" = n."owner_id"
      LEFT JOIN "public"."archive_space_items" a ON a."node_id" = si."node_id"
      -- The login a personal space belonged to, as its archive rows name
      -- it: the author of its own items, the taking admin of a taken one
      -- (whose author is the member it was taken from).
      LEFT JOIN LATERAL (
        SELECT CASE WHEN a2."review_state" = 'taken' THEN a2."taken_by" ELSE a2."author_login_id" END AS login
          FROM "public"."archive_space_items" a2
          JOIN "public"."nodes" n2 ON n2."id" = a2."node_id"
         WHERE s."kind" = 'personal' AND n2."owner_id" = s."id"
           AND CASE WHEN a2."review_state" = 'taken' THEN a2."taken_by" ELSE a2."author_login_id" END IS NOT NULL
         ORDER BY a2."archived_at", a2."node_id"
         LIMIT 1) sib ON true;

    -- Recorded before, its home no longer a registered private or Former
    -- user workspace (its login deleted and the orphan not taken over
    -- above): it moves to its login's workspace (Former user when gone).
    UPDATE pg_temp."ws_review_items" i SET "stranded" = true
      FROM "public"."space_item_homes" h
     WHERE h."node_id" = i."node_id" AND NOT i."fresh"
       AND (i."home_login" IS NOT NULL OR i."former_key" IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                        WHERE p."workspace_id" = h."home_workspace_id")
       AND NOT EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f
                        WHERE f."workspace_id" = h."home_workspace_id");

    -- The private workspaces still missing.
    c := 0;
    FOR r IN
      SELECT DISTINCT i."home_login" AS login,
             left(coalesce(nullif(btrim(u."display_name"), ''), split_part(u."email", '@', 1)), 100) AS label
        FROM pg_temp."ws_review_items" i
        JOIN auth.users u ON u."id" = i."home_login"
       WHERE (i."fresh" OR i."stranded")
         AND NOT EXISTS (SELECT 1 FROM "public"."private_workspaces" p WHERE p."login_id" = i."home_login")
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

    -- The "Former user" workspaces still missing (no users), one per
    -- former user.
    c := 0;
    FOR r IN
      SELECT DISTINCT i."former_key" AS former
        FROM pg_temp."ws_review_items" i
       WHERE (i."fresh" OR i."stranded") AND i."home_login" IS NULL AND i."former_key" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f WHERE f."former_key" = i."former_key")
       ORDER BY 1
    LOOP
      INSERT INTO "public"."workspaces" ("owner_id", "name", "description")
      VALUES (brain, 'Former user', 'The work of a login that was removed. It has no users; an Admin user may join it.')
      RETURNING "id" INTO ws;
      INSERT INTO "public"."former_user_workspaces" ("former_key", "workspace_id") VALUES (r.former, ws);
      INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
      VALUES (ws, NULL, 'review_off.former', '{}'::jsonb);
      c := c + 1;
    END LOOP;
    RETURN QUERY SELECT 'homes'::text, 'former user workspaces'::text, 'made'::text, c;

    UPDATE "public"."space_item_homes" h
       SET "home_workspace_id" = coalesce(p."workspace_id", f."workspace_id"), "resolved_at" = now()
      FROM pg_temp."ws_review_items" i
      LEFT JOIN "public"."private_workspaces" p ON p."login_id" = i."home_login"
      LEFT JOIN "public"."former_user_workspaces" f
        ON i."home_login" IS NULL AND f."former_key" = i."former_key"
     WHERE i."node_id" = h."node_id" AND i."stranded"
       AND coalesce(p."workspace_id", f."workspace_id") IS NOT NULL;
    GET DIAGNOSTICS c = ROW_COUNT;
    RETURN QUERY SELECT 'homes'::text, 'moved off a removed workspace'::text, 'rows'::text, c;

    -- The grants W6b writes (9.3), for every space item.
    IF to_regclass('pg_temp.ws_review_grants') IS NULL THEN
      CREATE TEMP TABLE pg_temp."ws_review_grants" (
        "node_id" uuid PRIMARY KEY, "grant_admin" boolean, "grant_team" boolean) ON COMMIT DROP;
    END IF;
    TRUNCATE pg_temp."ws_review_grants";
    INSERT INTO pg_temp."ws_review_grants"
    SELECT x."node_id",
           (x.open AND (x.submitted OR x.left_behind)) OR x.released,
           x.open AND ((x."sharing" = 'team' AND (x."state" IN ('draft', 'returned') OR x.submitted)
                        AND x."author_role" = 'member' AND x.active_member)
                       OR (x."author_role" = 'client' AND x.submitted))
      FROM (
        SELECT i.*,
               i."state" NOT IN ('accepted', 'taken') AND NOT i."trashed" AS open,
               i."state" = 'submitted' OR EXISTS (
                 SELECT 1 FROM "public"."archive_space_item_bundles" b
                   JOIN "public"."archive_space_items" root ON root."node_id" = b."root_id"
                  WHERE b."node_id" = i."node_id" AND root."review_state" = 'submitted') AS submitted,
               -- Left behind: a member's or client's (or a deleted login's)
               -- team-shared draft or returned item, its login gone or
               -- disabled. Never a disabled admin's own item.
               i."personal" AND i."sharing" = 'team' AND i."state" IN ('draft', 'returned')
                 AND (u."id" IS NULL OR (u."disabled_at" IS NOT NULL AND u."role" IN ('member', 'client')))
                 AS left_behind,
               i."personal" AND coalesce(u."role" = 'member' AND u."disabled_at" IS NULL, false) AS active_member,
               -- Released: taken by an admin who can no longer act on it.
               i."state" = 'taken' AND NOT i."trashed"
                 AND (tk."id" IS NULL OR tk."disabled_at" IS NOT NULL OR tk."role" <> 'admin') AS released
          FROM pg_temp."ws_review_items" i
          LEFT JOIN auth.users u ON u."id" = i."space_login"
          LEFT JOIN auth.users tk ON tk."id" = i."taken_by") x;

    -- Recorded before: the grants refreshed from what is live now.
    UPDATE "public"."space_item_homes" h
       SET "grant_admin" = g."grant_admin", "grant_team" = g."grant_team", "resolved_at" = now()
      FROM pg_temp."ws_review_grants" g
     WHERE g."node_id" = h."node_id"
       AND (h."grant_admin", h."grant_team") IS DISTINCT FROM (g."grant_admin", g."grant_team");
    GET DIAGNOSTICS c = ROW_COUNT;
    RETURN QUERY SELECT 'homes'::text, 'grants refreshed'::text, 'rows'::text, c;

    -- New: the home and its grants.
    INSERT INTO "public"."space_item_homes"
           ("node_id", "home_workspace_id", "grant_admin", "grant_team", "write",
            "state_before", "sharing_before", "author_role", "snapshot", "resolved_at")
    SELECT i."node_id", coalesce(p."workspace_id", f."workspace_id", i."kept_home"),
           g."grant_admin", g."grant_team", false, i."state", i."sharing_before", i."author_role",
           -- The author's snapshot copy (S3): only an accepted item homed in
           -- a private or Former user workspace. Kept in a brain workspace:
           -- no copy.
           i."state" = 'accepted' AND coalesce(p."workspace_id", f."workspace_id") IS NOT NULL,
           now()
      FROM pg_temp."ws_review_items" i
      JOIN pg_temp."ws_review_grants" g ON g."node_id" = i."node_id"
      LEFT JOIN "public"."private_workspaces" p ON p."login_id" = i."home_login"
      LEFT JOIN "public"."former_user_workspaces" f
        ON i."home_login" IS NULL AND f."former_key" = i."former_key"
     WHERE i."fresh";

    -- The snapshot rule, for every home (a home moved above, a hand edit):
    -- true only for an accepted item homed in a private or Former user
    -- workspace.
    UPDATE "public"."space_item_homes" h
       SET "snapshot" = x.want, "resolved_at" = now()
      FROM (SELECT h2."node_id",
                   h2."state_before" = 'accepted'
                     AND (EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                                   WHERE p."workspace_id" = h2."home_workspace_id")
                          OR EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f
                                      WHERE f."workspace_id" = h2."home_workspace_id")) AS want
              FROM "public"."space_item_homes" h2) x
     WHERE x."node_id" = h."node_id" AND h."snapshot" IS DISTINCT FROM x.want;
    GET DIAGNOSTICS c = ROW_COUNT;
    RETURN QUERY SELECT 'homes'::text, 'snapshot flag set by the rule'::text, 'rows'::text, c;

    RETURN QUERY
      SELECT 'homes'::text,
             CASE WHEN EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                                WHERE p."workspace_id" = h."home_workspace_id") THEN 'private'
                  WHEN EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f
                                WHERE f."workspace_id" = h."home_workspace_id") THEN 'former user'
                  ELSE 'kept (author unknown)' END
               || ', ' || h."state_before" || CASE WHEN h."sharing_before" = 'team' THEN ' (team-shared)' ELSE '' END,
             'recorded' || CASE WHEN h."grant_admin" THEN ', grant Admin' ELSE '' END
                        || CASE WHEN h."grant_team" THEN ', grant Team' ELSE '' END
                        || CASE WHEN h."snapshot" THEN ', snapshot copy' ELSE '' END,
             count(*)
        FROM "public"."space_item_homes" h
        JOIN pg_temp."ws_review_items" i ON i."node_id" = h."node_id"
       WHERE i."fresh"
       GROUP BY 2, 3;
  END IF;

  -- 3. The states resolve: submitted, returned and taken become draft; the
  --    review columns clear. Accepted rows, sharing and the trash stay.
  IF to_regclass('pg_temp.ws_review_resolve') IS NULL THEN
    CREATE TEMP TABLE pg_temp."ws_review_resolve" ("node_id" uuid PRIMARY KEY, "was" text) ON COMMIT DROP;
  END IF;
  TRUNCATE pg_temp."ws_review_resolve";
  INSERT INTO pg_temp."ws_review_resolve"
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
    FROM pg_temp."ws_review_resolve" x
   WHERE si."node_id" = x."node_id";
  RETURN QUERY
    SELECT 'states'::text, x."was", 'resolved to draft'::text, count(*)
      FROM pg_temp."ws_review_resolve" x GROUP BY x."was";

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
  SELECT ck."n" INTO stray_snapshots FROM "public"."mantle_ws_review_homes_check"() ck
   WHERE ck."metric" = 'snapshot homes outside a private or Former user workspace';
  IF left_states > 0 OR open_subs > 0 OR open_bundles > 0 OR not_archived > 0
     OR stray_snapshots > 0 OR (admin_ws IS NOT NULL AND missing > 0) THEN
    RAISE EXCEPTION 'review off: % item(s) without a home, % still in review, % submission(s), % bundle row(s), % row(s) not archived, % snapshot copy(ies) outside a private or Former user workspace; nothing written',
      CASE WHEN admin_ws IS NULL THEN 0 ELSE missing END, left_states, open_subs, open_bundles, not_archived,
      stray_snapshots
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
