-- Workspaces, phase W1b: the migration plan as a READ-ONLY dry run, and the
-- reach diff (plan sections 9, 12 and 21.9). No table is written: the plan
-- goes into temporary tables that drop at commit, and the function returns
-- a report of numbers only (no titles, no text), so it can run on a copy of
-- any box and, read only, on a live box as the pre-flight.
--
--   select * from mantle_ws_dry_run();
--
-- The plan (owner decisions, 21.9):
--  - Stop when client logins or client-level items exist: clients are set
--    up by hand, never migrated.
--  - Workspaces: Admin (every admin login, Moderator), Team (every member
--    and admin login, all Moderators; Admin users moderate it by
--    admin_moderated), and one private workspace per login ("only you").
--    A personal space whose login is gone gets a "former user" workspace
--    with no users.
--  - Brain items: home Admin, granted to Admin; also to Team when the team
--    role reads them today. Apps the team reads (T1): home Team, granted to
--    Team only, Write on unless data_read_only. An embed never grants an
--    app (old trap 2).
--  - Personal items: home the login's private workspace; plus Team for a
--    team-shared draft or returned item of an active member; plus Admin for
--    a submitted item and a left-behind one (9.3).
--
-- The reach diff compares, for every login and for the two assistants,
-- what they read today (OLD) with what the plan gives them (NEW). For a
-- login, NEW minus OLD must be empty. For an assistant, NEW minus OLD lists
-- the expected gains of 9.4 rule 2 (18.13): team-shared drafts for the Team
-- assistant, submitted and left-behind items for the Admin assistant.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_team_reads"(
  t "public"."node_type", audience text, inherited text, embedded text)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  -- The team role's read rule today (nodes_viewer_read, 0208), for a brain
  -- item: its own level, its folder's share or an embedder's share.
  -- Never NULL: a missing share or embed level reads as "no" (a NULL here
  -- once dropped admin-only apps out of every planned grant).
  SELECT coalesce("public"."mantle_workspace_kind"(t), false)
     AND (coalesce(audience IN ('team', 'client', 'public'), false)
          OR coalesce(inherited IN ('team', 'client'), false)
          OR coalesce(embedded IN ('team', 'client', 'public'), false))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_ws_dry_run"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  brain uuid := "public"."mantle_brain_id"();
BEGIN
  IF brain IS NULL THEN
    RETURN QUERY SELECT 'stop'::text, 'brain'::text, 'no brain anchor'::text, 1::bigint;
    RETURN;
  END IF;

  -- ── Stop conditions (21.9) ────────────────────────────────────────────
  RETURN QUERY
    SELECT 'stop', 'client logins', 'count', count(*)
      FROM auth.users u WHERE u.role = 'client'
     HAVING count(*) > 0;
  RETURN QUERY
    SELECT 'stop', 'client-level items', 'count', count(*)
      FROM "public"."nodes" n
     WHERE n.owner_id = brain
       AND (n.audience = 'client' OR n.inherited_level = 'client' OR n.embedded_level = 'client')
     HAVING count(*) > 0;

  -- ── Planned workspaces and users ──────────────────────────────────────
  CREATE TEMP TABLE _wsp_ws (key text PRIMARY KEY, label text) ON COMMIT DROP;
  CREATE TEMP TABLE _wsp_users (key text, login_id uuid, moderator boolean,
                                PRIMARY KEY (key, login_id)) ON COMMIT DROP;
  INSERT INTO _wsp_ws VALUES ('admin', 'Admin'), ('team', 'Team');
  INSERT INTO _wsp_users
    SELECT 'admin', u.id, true FROM auth.users u WHERE u.role = 'admin';
  INSERT INTO _wsp_users
    SELECT 'team', u.id, true FROM auth.users u WHERE u.role IN ('admin', 'member');
  INSERT INTO _wsp_ws
    SELECT 'private:' || u.id, 'private' FROM auth.users u WHERE u.role IN ('admin', 'member');
  INSERT INTO _wsp_users
    SELECT 'private:' || u.id, u.id, true FROM auth.users u WHERE u.role IN ('admin', 'member');
  -- Personal spaces whose login is gone: a "former user" workspace, no users.
  INSERT INTO _wsp_ws
    SELECT 'former:' || s.id, 'former user'
      FROM "public"."spaces" s
     WHERE s.kind = 'personal' AND s.login_id IS NULL
       AND EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.owner_id = s.id);

  -- ── Planned grants ────────────────────────────────────────────────────
  CREATE TEMP TABLE _wsp_grants (node_id uuid, key text, write boolean, is_home boolean,
                                 PRIMARY KEY (node_id, key)) ON COMMIT DROP;

  -- Brain items: home Admin, granted to Admin; to Team where the team reads
  -- them today. Apps the team reads: home Team, Team only (T1).
  INSERT INTO _wsp_grants
    SELECT n.id, 'admin', false, true
      FROM "public"."nodes" n
     WHERE n.owner_id = brain
       AND NOT (n.type = 'app' AND "public"."mantle_team_reads"(n.type, n.audience, n.inherited_level, NULL));
  INSERT INTO _wsp_grants
    SELECT n.id, 'team',
           CASE WHEN n.type = 'app' THEN NOT coalesce(a.data_read_only, false) ELSE false END,
           n.type = 'app'
      FROM "public"."nodes" n
      LEFT JOIN "public"."apps" a ON a.node_id = n.id
     WHERE n.owner_id = brain
       AND "public"."mantle_kind_class"(n.type) <> 'admin_only'
       AND "public"."mantle_team_reads"(
             n.type, n.audience, n.inherited_level,
             CASE WHEN n.type = 'app' THEN NULL ELSE n.embedded_level END)
    ON CONFLICT DO NOTHING;

  -- Personal items: home the private (or former user) workspace.
  INSERT INTO _wsp_grants
    SELECT n.id, CASE WHEN s.login_id IS NULL THEN 'former:' || s.id ELSE 'private:' || s.login_id END,
           false, true
      FROM "public"."nodes" n
      JOIN "public"."spaces" s ON s.id = n.owner_id AND s.kind = 'personal'
     WHERE s.login_id IS NULL OR EXISTS (SELECT 1 FROM _wsp_ws w WHERE w.key = 'private:' || s.login_id);
  -- A team-shared draft or returned item of an active member: + Team.
  INSERT INTO _wsp_grants
    SELECT n.id, 'team', false, false
      FROM "public"."nodes" n
      JOIN "public"."space_items" si ON si.node_id = n.id
      JOIN "public"."spaces" s ON s.id = n.owner_id AND s.kind = 'personal'
      JOIN auth.users u ON u.id = s.login_id AND u.role = 'member' AND u.disabled_at IS NULL
     WHERE si.sharing = 'team' AND si.review_state IN ('draft', 'returned')
    ON CONFLICT DO NOTHING;
  -- Submitted, or left behind by a login that is gone or disabled: + Admin.
  INSERT INTO _wsp_grants
    SELECT n.id, 'admin', false, false
      FROM "public"."nodes" n
      JOIN "public"."space_items" si ON si.node_id = n.id
      JOIN "public"."spaces" s ON s.id = n.owner_id AND s.kind = 'personal'
      LEFT JOIN auth.users u ON u.id = s.login_id
     WHERE si.review_state = 'submitted'
        OR (si.review_state IN ('draft', 'returned') AND si.sharing = 'team'
            AND (u.id IS NULL OR u.disabled_at IS NOT NULL))
    ON CONFLICT DO NOTHING;

  -- ── Every item must have exactly one home in the plan ──────────────────
  RETURN QUERY
    SELECT 'plan-fail', 'items without a home', 'count', count(*)
      FROM "public"."nodes" n
     WHERE (n.owner_id = brain
            OR EXISTS (SELECT 1 FROM "public"."spaces" s WHERE s.id = n.owner_id AND s.kind = 'personal'))
       AND NOT EXISTS (SELECT 1 FROM _wsp_grants g WHERE g.node_id = n.id AND g.is_home)
    HAVING count(*) > 0;
  RETURN QUERY
    SELECT 'plan-fail', 'items with more than one home', 'count', count(*)
      FROM (SELECT g.node_id FROM _wsp_grants g WHERE g.is_home GROUP BY 1 HAVING count(*) > 1) x
    HAVING count(*) > 0;

  -- ── Plan counts ───────────────────────────────────────────────────────
  RETURN QUERY SELECT 'plan', 'workspaces', 'count', count(*) FROM _wsp_ws;
  RETURN QUERY SELECT 'plan', 'workspace users', 'count', count(*) FROM _wsp_users;
  RETURN QUERY
    SELECT 'plan', 'grants to ' || CASE WHEN g.key LIKE 'private:%' THEN 'private'
                                         WHEN g.key LIKE 'former:%' THEN 'former user'
                                         ELSE g.key END, 'count', count(*)
      FROM _wsp_grants g GROUP BY 2;
  RETURN QUERY
    SELECT 'plan', 'apps homed in Team (T1)', 'count', count(*)
      FROM _wsp_grants g JOIN "public"."nodes" n ON n.id = g.node_id
     WHERE g.key = 'team' AND g.is_home AND n.type = 'app';
  RETURN QUERY
    SELECT 'plan', 'apps homed in Team, Write on', 'count', count(*)
      FROM _wsp_grants g JOIN "public"."nodes" n ON n.id = g.node_id
     WHERE g.key = 'team' AND g.is_home AND n.type = 'app' AND g.write;
  RETURN QUERY
    SELECT 'plan', 'embedded-only apps losing team read (old trap 2)', 'count', count(*)
      FROM "public"."nodes" n
     WHERE n.owner_id = brain AND n.type = 'app'
       AND NOT "public"."mantle_team_reads"(n.type, n.audience, n.inherited_level, NULL)
       AND "public"."mantle_team_reads"(n.type, n.audience, n.inherited_level, n.embedded_level);
  RETURN QUERY
    SELECT 'plan', 'accepted at admin, snapshot copy needed (S3)', 'count', count(*)
      FROM "public"."space_items" si JOIN "public"."nodes" n ON n.id = si.node_id
     WHERE si.review_state IN ('accepted', 'taken') AND n.owner_id = brain AND n.audience = 'admin'
       AND NOT "public"."mantle_team_reads"(n.type, n.audience, n.inherited_level, n.embedded_level);
  RETURN QUERY
    SELECT 'plan', 'items with embeds (summaries hidden outside Admin until re-summarised, R8)', 'count',
           count(DISTINCT e.from_id)
      FROM "public"."node_embeds" e JOIN _wsp_grants g ON g.node_id = e.from_id AND g.key <> 'admin';
  RETURN QUERY
    SELECT 'plan', 'review state ' || si.review_state || CASE WHEN si.sharing = 'team' THEN ' (team-shared)' ELSE '' END,
           'count', count(*)
      FROM "public"."space_items" si GROUP BY 2;

  -- ── OLD reach: what each subject reads today ──────────────────────────
  CREATE TEMP TABLE _wsp_old (subject text, node_id uuid, PRIMARY KEY (subject, node_id)) ON COMMIT DROP;
  -- Every admin login: the whole brain, its own space, and the review side
  -- (team-shared items of active members, submitted and left-behind items).
  INSERT INTO _wsp_old
    SELECT 'login:' || u.id, n.id
      FROM auth.users u JOIN "public"."nodes" n ON n.owner_id = brain
     WHERE u.role = 'admin';
  INSERT INTO _wsp_old
    SELECT 'login:' || u.id, g.node_id
      FROM auth.users u JOIN _wsp_grants g ON g.key = 'admin' AND NOT g.is_home
     WHERE u.role = 'admin'
    ON CONFLICT DO NOTHING;
  INSERT INTO _wsp_old
    SELECT 'login:' || u.id, si.node_id
      FROM auth.users u
      JOIN "public"."space_items" si ON si.sharing = 'team' AND si.review_state IN ('draft', 'returned')
      JOIN "public"."nodes" n ON n.id = si.node_id
      JOIN "public"."spaces" s ON s.id = n.owner_id AND s.kind = 'personal'
      JOIN auth.users au ON au.id = s.login_id AND au.role = 'member' AND au.disabled_at IS NULL
     WHERE u.role = 'admin'
    ON CONFLICT DO NOTHING;
  -- Every member: what the team role reads, plus teammates' team-shared
  -- drafts (the human flag).
  INSERT INTO _wsp_old
    SELECT 'login:' || u.id, n.id
      FROM auth.users u JOIN "public"."nodes" n ON n.owner_id = brain
     WHERE u.role = 'member'
       AND "public"."mantle_team_reads"(n.type, n.audience, n.inherited_level, n.embedded_level);
  INSERT INTO _wsp_old
    SELECT 'login:' || u.id, si.node_id
      FROM auth.users u
      JOIN "public"."space_items" si ON si.sharing = 'team' AND si.review_state IN ('draft', 'returned')
      JOIN "public"."nodes" n ON n.id = si.node_id
      JOIN "public"."spaces" s ON s.id = n.owner_id AND s.kind = 'personal'
      JOIN auth.users au ON au.id = s.login_id AND au.role = 'member' AND au.disabled_at IS NULL
     WHERE u.role = 'member'
    ON CONFLICT DO NOTHING;
  -- Every login: its own personal space.
  INSERT INTO _wsp_old
    SELECT 'login:' || s.login_id, n.id
      FROM "public"."spaces" s JOIN "public"."nodes" n ON n.owner_id = s.id
     WHERE s.kind = 'personal' AND s.login_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  -- The assistants: the owner's reads the brain; the team responder reads
  -- what the team role reads (never drafts).
  INSERT INTO _wsp_old SELECT 'assistant:admin', n.id FROM "public"."nodes" n WHERE n.owner_id = brain;
  INSERT INTO _wsp_old
    SELECT 'assistant:team', n.id FROM "public"."nodes" n
     WHERE n.owner_id = brain
       AND "public"."mantle_team_reads"(n.type, n.audience, n.inherited_level, n.embedded_level);

  -- ── NEW reach: what the plan gives them ───────────────────────────────
  CREATE TEMP TABLE _wsp_new (subject text, node_id uuid, PRIMARY KEY (subject, node_id)) ON COMMIT DROP;
  INSERT INTO _wsp_new
    SELECT DISTINCT 'login:' || wu.login_id, g.node_id
      FROM _wsp_users wu JOIN _wsp_grants g ON g.key = wu.key;
  INSERT INTO _wsp_new SELECT DISTINCT 'assistant:admin', g.node_id FROM _wsp_grants g WHERE g.key = 'admin';
  INSERT INTO _wsp_new SELECT DISTINCT 'assistant:team', g.node_id FROM _wsp_grants g WHERE g.key = 'team';

  -- ── The diff ──────────────────────────────────────────────────────────
  RETURN QUERY
    SELECT 'reach', s.subject_kind, 'subjects', count(*)
      FROM (SELECT DISTINCT split_part(subject, ':', 1) AS subject_kind, subject FROM _wsp_new) s
     GROUP BY 2;
  -- A login that gains anything is a failure (9.4 rule 1): reported per
  -- login role, with the gained count.
  RETURN QUERY
    SELECT 'reach-fail', 'login (' || u.role || ')', 'gained items', count(*)
      FROM _wsp_new nw
      JOIN auth.users u ON 'login:' || u.id = nw.subject
     WHERE NOT EXISTS (SELECT 1 FROM _wsp_old o WHERE o.subject = nw.subject AND o.node_id = nw.node_id)
     GROUP BY 2;
  RETURN QUERY
    SELECT 'reach', 'login (' || u.role || ')', 'lost items (narrower, allowed)', count(*)
      FROM _wsp_old o
      JOIN auth.users u ON 'login:' || u.id = o.subject
     WHERE NOT EXISTS (SELECT 1 FROM _wsp_new nw WHERE nw.subject = o.subject AND nw.node_id = o.node_id)
     GROUP BY 2;
  -- The assistants' gains, by kind (9.4 rule 2: the owner signs these off).
  RETURN QUERY
    SELECT 'reach-expected', nw.subject,
           'gained: ' || CASE WHEN si.review_state = 'submitted' THEN 'submitted items'
                              WHEN si.sharing = 'team' AND nw.subject = 'assistant:team' THEN 'team-shared drafts'
                              WHEN si.node_id IS NOT NULL THEN 'left-behind items'
                              ELSE 'OTHER (not expected)' END,
           count(*)
      FROM _wsp_new nw
      LEFT JOIN "public"."space_items" si ON si.node_id = nw.node_id
     WHERE nw.subject LIKE 'assistant:%'
       AND NOT EXISTS (SELECT 1 FROM _wsp_old o WHERE o.subject = nw.subject AND o.node_id = nw.node_id)
     GROUP BY 2, 3;
  RETURN QUERY
    SELECT 'reach', o.subject, 'lost items (narrower, allowed)', count(*)
      FROM _wsp_old o
     WHERE o.subject LIKE 'assistant:%'
       AND NOT EXISTS (SELECT 1 FROM _wsp_new nw WHERE nw.subject = o.subject AND nw.node_id = o.node_id)
     GROUP BY 2;
END
$$;
