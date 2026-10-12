-- Workspaces W8a: a login carries nothing. There is no client login role
-- and no email-code sign-in any more (owner decision 2026-10-11): every
-- login is an admin or a member row, and what it reads and may do comes
-- from its workspaces only, never from its role.
--
-- 1. Every client login is archived (archive_client_logins: its auth row,
--    no password hash), then ended exactly as an admin's End sessions plus
--    Disable end a login: disabled, its session epoch bumped, its device
--    tokens and API keys revoked, its push devices removed, its OAuth grants
--    revoked and its OAuth codes deleted, the peers bound to it unbound and
--    switched off (Write off, no risky tools). Then its role becomes
--    member, and the role CHECK admits admin and member only. The row
--    stays: what it wrote keeps its author. Nobody is added to a workspace,
--    and no notify fires (the role and disable triggers on auth.users are
--    off for that one UPDATE).
--    A former client stays one (W8a fix round 1): on a brain already on
--    workspaces, every workspace_users row of a client login is archived
--    (archive_client_workspace_users) and removed, so a later re-enable
--    grants nothing by itself. A brain not on workspaces yet counts its
--    archived client logins as clients present (mantle_ws_skip_reason), so
--    it is never switched at boot (owner rule 21.9: clients are set up by
--    hand), and the login bridge treats an archived client login as having
--    no role (mantle_bridge_login): no switch, manual or not, makes a
--    former client a Moderator of Admin or Team.
--    Its private workspace rows go too (W8a leftover, closed in W8d): each
--    private_workspaces row of a former client is archived
--    (archive_client_private_workspaces) and removed, and at the end of
--    this migration (W8 integration) that workspace is renamed "Former
--    user", its events lose the name and description it was given, and it
--    is registered as the former client's Former user workspace, as the
--    review homes do for a deleted login's: a migrated box never runs the
--    review homes again, so nothing would.
--    Nor of a private workspace (W8a fix round 2): the review homes (0264),
--    the spaces fold (0267) and the app's private workspace function treat
--    an archived client login as a login that is gone. It never gets a
--    private workspace; its items go to its Former user workspace (no
--    users), as a deleted login's do. Those functions are redefined here,
--    the released migrations are not edited.
-- 2. The email-code sign-in tables (client_signin_codes,
--    client_signin_code_skips, client_signin_sender_folders) and the static
--    login tokens (mcp_login_tokens, retired since W7b and revoked by 0268)
--    are archived as metadata only (never a code, a token hash, a request
--    id or an address), then dropped.
-- 3. The role a key or a peer was made under is archived (archive_key_roles,
--    archive_peer_roles), then its column dropped: a key and a peer act as
--    their login as it is now. A credential that the old role check was
--    refusing (its login's role changed after it was made) is ended first,
--    so none comes back to life: such a key is revoked, such a peer
--    unbound.
--
-- Every archive is counted against what it copied; a mismatch raises and
-- the whole migration rolls back. Every drop is RESTRICT. No LLM work is
-- queued and no notify fires.
--
-- Re-runnable: the archives are CREATE IF NOT EXISTS and their inserts ON
-- CONFLICT DO NOTHING; every step reads only what is still there (a client
-- row, a table or a column not yet dropped), so a second run changes
-- nothing.
--
-- The `when` sits above 1790195520000 (0271's): migrate.ts skips a
-- migration whose `when` is at or below the highest one applied.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Every table this migration changes, in one statement with a short wait
-- and a retry, like 0269, 0270 and 0271: waiting on one while holding the
-- others would stall every reader. The tables it drops are locked in the
-- same attempt when they are still there (a second run finds them gone).
DO $$
DECLARE
  attempt int := 0;
  t text;
  droppable CONSTANT text[] := ARRAY[
    'public.client_signin_codes', 'public.client_signin_code_skips',
    'public.client_signin_sender_folders', 'public.mcp_login_tokens'];
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      LOCK TABLE "auth"."users", "public"."access_keys", "public"."mantle_peers",
                 "public"."mobile_tokens", "public"."push_subscriptions",
                 "public"."oauth_auth_codes", "public"."oauth_access_tokens",
                 "public"."workspace_users", "public"."private_workspaces"
        IN ACCESS EXCLUSIVE MODE;
      FOREACH t IN ARRAY droppable LOOP
        IF to_regclass(t) IS NOT NULL THEN
          EXECUTE 'LOCK TABLE ' || t || ' IN ACCESS EXCLUSIVE MODE';
        END IF;
      END LOOP;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= 20 THEN
        RAISE EXCEPTION '0272: the tables stayed busy for 20 attempts; run the migration again at a quieter time'
          USING ERRCODE = 'lock_not_available';
      END IF;
      RAISE NOTICE '0272: tables busy (attempt %), retrying', attempt;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── The archives ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."archive_client_logins" (
  "login_id"       uuid PRIMARY KEY,
  "email"          text NOT NULL,
  "display_name"   text,
  "contact_id"     uuid,
  "created_at"     timestamptz NOT NULL,
  "last_login_at"  timestamptz,
  "disabled_at"    timestamptz,
  "session_epoch"  integer NOT NULL,
  "archived_at"    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- A client login's workspace rows on a brain already on workspaces, as they
-- were when they were removed (W8a fix round 1).
CREATE TABLE IF NOT EXISTS "public"."archive_client_workspace_users" (
  "workspace_id" uuid NOT NULL,
  "login_id"     uuid NOT NULL,
  "moderator"    boolean NOT NULL,
  "limits"       jsonb NOT NULL,
  "added_by"     uuid,
  "added_at"     timestamptz NOT NULL,
  "archived_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "login_id")
);
--> statement-breakpoint
-- A former client's private workspace row (W8d): which workspace was its
-- "(only you)" workspace when the row was removed.
CREATE TABLE IF NOT EXISTS "public"."archive_client_private_workspaces" (
  "login_id"     uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL,
  "created_at"   timestamptz NOT NULL,
  "archived_at"  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_client_signin_codes" (
  "id"          uuid PRIMARY KEY,
  "owner_id"    uuid NOT NULL,
  "login_id"    uuid NOT NULL,
  "kind"        text NOT NULL,
  "expires_at"  timestamptz NOT NULL,
  "attempts"    integer NOT NULL,
  "used_at"     timestamptz,
  "revoked_at"  timestamptz,
  "sent_at"     timestamptz,
  "send_error"  text,
  "created_by"  uuid,
  "created_at"  timestamptz NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_client_signin_code_skips" (
  "id"          uuid PRIMARY KEY,
  "reason"      text NOT NULL,
  "created_at"  timestamptz NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_client_signin_sender_folders" (
  "account_id"  uuid PRIMARY KEY,
  "folders"     text[] NOT NULL,
  "updated_at"  timestamptz NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_mcp_login_tokens" (
  "id"            uuid PRIMARY KEY,
  "login_id"      uuid NOT NULL,
  "label"         text NOT NULL,
  "session_epoch" integer NOT NULL,
  "created_by"    uuid,
  "last_used_at"  timestamptz,
  "revoked_at"    timestamptz,
  "created_at"    timestamptz NOT NULL,
  "archived_at"   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_key_roles" (
  "key_id"      uuid PRIMARY KEY,
  "login_role"  text NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_peer_roles" (
  "peer_id"            uuid PRIMARY KEY,
  "acts_as_role"       text,
  "ended_acts_as_role" text,
  "archived_at"        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Admin pool and definer functions only (access-matrix.ts).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['archive_client_logins', 'archive_client_workspace_users',
                           'archive_client_private_workspaces',
                           'archive_client_signin_codes',
                           'archive_client_signin_code_skips',
                           'archive_client_signin_sender_folders', 'archive_mcp_login_tokens',
                           'archive_key_roles', 'archive_peer_roles'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', 'public.' || quote_ident(t));
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', 'public.' || quote_ident(t));
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── 1. The client logins ────────────────────────────────────────────────────

DO $$
DECLARE
  clients int;
  archived int;
BEGIN
  SELECT count(*) INTO clients FROM auth.users u WHERE u."role" = 'client';
  INSERT INTO "public"."archive_client_logins"
         ("login_id", "email", "display_name", "contact_id", "created_at", "last_login_at",
          "disabled_at", "session_epoch")
  SELECT u."id", u."email", u."display_name", u."contact_id", u."created_at", u."last_login_at",
         u."disabled_at", u."session_epoch"
    FROM auth.users u
   WHERE u."role" = 'client'
  ON CONFLICT ("login_id") DO NOTHING;
  SELECT count(*) INTO archived
    FROM auth.users u JOIN "public"."archive_client_logins" a ON a."login_id" = u."id"
   WHERE u."role" = 'client';
  IF archived <> clients THEN
    RAISE EXCEPTION '0272: archived % of % client logins', archived, clients;
  END IF;
  IF clients > 0 THEN
    RAISE NOTICE '0272: % client logins archived and ended', clients;
  END IF;
END
$$;
--> statement-breakpoint
-- Every credential of a client login, as endLoginSessions with endKeys ends
-- them (server/web/lib/auth/session.ts), keyed on the role that is still
-- 'client' here: a second run finds none.
UPDATE "public"."mobile_tokens" t SET "revoked_at" = now()
  FROM auth.users u
 WHERE t."user_id" = u."id" AND u."role" = 'client' AND t."revoked_at" IS NULL;
--> statement-breakpoint
DELETE FROM "public"."push_subscriptions" s
 USING auth.users u
 WHERE s."login_id" = u."id" AND u."role" = 'client';
--> statement-breakpoint
UPDATE "public"."access_keys" k SET "revoked_at" = now()
  FROM auth.users u
 WHERE k."login_id" = u."id" AND u."role" = 'client' AND k."revoked_at" IS NULL;
--> statement-breakpoint
UPDATE "public"."oauth_access_tokens" t SET "revoked_at" = now()
  FROM auth.users u
 WHERE t."actor_id" = u."id" AND u."role" = 'client' AND t."revoked_at" IS NULL;
--> statement-breakpoint
DELETE FROM "public"."oauth_auth_codes" c
 USING auth.users u
 WHERE c."actor_id" = u."id" AND u."role" = 'client';
--> statement-breakpoint
-- A peer bound to a client: unbound (the binding remembered, as
-- lib/peer-unbind.ts does), switched off, its Write off and its risky tools
-- cleared (as step 3 ends a peer the old role check refused).
UPDATE "public"."mantle_peers" p
   SET "ended_acts_as_login_id" = p."acts_as_login_id",
       "acts_as_login_id" = NULL,
       "enabled" = false,
       "write_enabled" = false,
       "allowed_risky_tools" = '{}'::text[],
       "updated_at" = now()
  FROM auth.users u
 WHERE p."acts_as_login_id" = u."id" AND u."role" = 'client';
--> statement-breakpoint
-- The login itself: disabled (a login already disabled keeps its time), its
-- epoch bumped (every cookie and asset token it holds dies), its role
-- member. The role guard of 0200 goes (no role is client any more); the
-- bridge (0251, when a brain has not switched yet) and the needs-you notify
-- (0186) are off for this UPDATE, so nobody is added to a workspace and
-- nothing is notified.
DROP TRIGGER IF EXISTS "users_client_role_guard" ON "auth"."users";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_client_role_guard"() RESTRICT;
--> statement-breakpoint
DO $$
DECLARE
  quiet CONSTANT text[] := ARRAY['users_zz_bridge', 'users_needs_you_upd_trg'];
  t text;
  off text[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u."role" = 'client') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY quiet LOOP
    IF EXISTS (SELECT 1 FROM pg_trigger g
                WHERE g.tgrelid = 'auth.users'::regclass AND g.tgname = t
                  AND NOT g.tgisinternal AND g.tgenabled <> 'D') THEN
      EXECUTE format('ALTER TABLE "auth"."users" DISABLE TRIGGER %I', t);
      off := off || t;
    END IF;
  END LOOP;
  UPDATE auth.users u
     SET "disabled_at" = coalesce(u."disabled_at", now()),
         "session_epoch" = u."session_epoch" + 1,
         "role" = 'member'
   WHERE u."role" = 'client';
  FOREACH t IN ARRAY off LOOP
    EXECUTE format('ALTER TABLE "auth"."users" ENABLE TRIGGER %I', t);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "auth"."users" DROP CONSTRAINT IF EXISTS "users_role_ck";
--> statement-breakpoint
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_role_ck"
  CHECK ("role" IN ('admin', 'member') AND (NOT "is_owner" OR "role" = 'admin'));
--> statement-breakpoint

-- ── 1b. A former client stays one (W8a fix round 1) ─────────────────────────

-- On a brain already on workspaces: every workspace row of a former client
-- (the bridge kept clients out of Admin and Team, but a workspace screen, a
-- private workspace of the spaces fold (0267) or a hand-made row may hold
-- one) is archived, then removed, so a later re-enable grants nothing by
-- itself. Counted: a mismatch raises and the whole migration rolls back.
-- Each removal is a workspace event. A second run finds none.
DO $$
DECLARE
  src int;
  kept int;
  gone int;
BEGIN
  SELECT count(*) INTO src FROM "public"."workspace_users" u
   WHERE u."login_id" IN (SELECT a."login_id" FROM "public"."archive_client_logins" a);
  IF src = 0 THEN
    RETURN;
  END IF;
  INSERT INTO "public"."archive_client_workspace_users"
         ("workspace_id", "login_id", "moderator", "limits", "added_by", "added_at")
  SELECT u."workspace_id", u."login_id", u."moderator", u."limits", u."added_by", u."added_at"
    FROM "public"."workspace_users" u
   WHERE u."login_id" IN (SELECT a."login_id" FROM "public"."archive_client_logins" a)
  ON CONFLICT ("workspace_id", "login_id") DO NOTHING;
  SELECT count(*) INTO kept FROM "public"."workspace_users" u
    JOIN "public"."archive_client_workspace_users" a
      ON a."workspace_id" = u."workspace_id" AND a."login_id" = u."login_id"
   WHERE u."login_id" IN (SELECT c."login_id" FROM "public"."archive_client_logins" c);
  IF kept <> src THEN
    RAISE EXCEPTION '0272: archived % of % workspace rows of former clients', kept, src;
  END IF;
  INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
  SELECT u."workspace_id", NULL, 'former_client.removed',
         jsonb_build_object('login', u."login_id", 'moderator', u."moderator")
    FROM "public"."workspace_users" u
   WHERE u."login_id" IN (SELECT a."login_id" FROM "public"."archive_client_logins" a);
  DELETE FROM "public"."workspace_users" u
   WHERE u."login_id" IN (SELECT a."login_id" FROM "public"."archive_client_logins" a);
  GET DIAGNOSTICS gone = ROW_COUNT;
  IF gone <> src THEN
    RAISE EXCEPTION '0272: removed % of % workspace rows of former clients', gone, src;
  END IF;
  RAISE NOTICE '0272: % workspace rows of former clients archived and removed', src;
END
$$;
--> statement-breakpoint
-- A former client's private workspace row (W8a leftover, closed in W8d): a
-- private workspace whose row is gone is a private workspace of a login
-- that is gone. The end of this migration makes it that login's Former
-- user workspace (W8 integration). Archived first, counted: a mismatch
-- raises and the whole migration rolls back. A second run finds none.
DO $$
DECLARE
  src int;
  kept int;
  gone int;
BEGIN
  SELECT count(*) INTO src FROM "public"."private_workspaces" p
   WHERE p."login_id" IN (SELECT a."login_id" FROM "public"."archive_client_logins" a);
  IF src = 0 THEN
    RETURN;
  END IF;
  INSERT INTO "public"."archive_client_private_workspaces" ("login_id", "workspace_id", "created_at")
  SELECT p."login_id", p."workspace_id", p."created_at"
    FROM "public"."private_workspaces" p
   WHERE p."login_id" IN (SELECT a."login_id" FROM "public"."archive_client_logins" a)
  ON CONFLICT ("login_id") DO NOTHING;
  SELECT count(*) INTO kept FROM "public"."private_workspaces" p
    JOIN "public"."archive_client_private_workspaces" a
      ON a."login_id" = p."login_id" AND a."workspace_id" = p."workspace_id"
   WHERE p."login_id" IN (SELECT c."login_id" FROM "public"."archive_client_logins" c);
  IF kept <> src THEN
    RAISE EXCEPTION '0272: archived % of % private workspace rows of former clients', kept, src;
  END IF;
  DELETE FROM "public"."private_workspaces" p
   WHERE p."login_id" IN (SELECT a."login_id" FROM "public"."archive_client_logins" a);
  GET DIAGNOSTICS gone = ROW_COUNT;
  IF gone <> src THEN
    RAISE EXCEPTION '0272: removed % of % private workspace rows of former clients', gone, src;
  END IF;
  RAISE NOTICE '0272: % private workspace rows of former clients archived and removed', src;
END
$$;
--> statement-breakpoint
-- Why this brain has no workspaces, or NULL when it has them (0257), with
-- the former clients: a brain not on workspaces yet that had client logins
-- (archive_client_logins, a login deleted since included) has clients
-- present, so the boot step never switches it (owner rule 21.9). A manual
-- run after the clients are set up by hand says so for its transaction:
--   BEGIN;
--   SET LOCAL mantle.ws_former_clients = 'reviewed';
--   SELECT * FROM mantle_ws_migrate_locked();
--   COMMIT;
-- Even then the bridge gives a former client no row (mantle_bridge_login).
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
  IF coalesce(current_setting('mantle.ws_former_clients', true), '') <> 'reviewed' THEN
    clients := clients + (
      SELECT count(*) FROM "public"."archive_client_logins" a
       WHERE NOT EXISTS (SELECT 1 FROM auth.users u
                          WHERE u."id" = a."login_id" AND u."role" = 'client'));
  END IF;
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
-- The login bridge (0251), with the former clients: a login in
-- archive_client_logins has no role here, so it is never put in Admin or
-- Team, and is taken out of them if it is in (a role change on the Users
-- or the Admin workspace screen, a manual switch, an invite redeemed).
CREATE OR REPLACE FUNCTION "public"."mantle_bridge_login"(login uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  admin_ws uuid;
  team_ws uuid;
  r text;
  changed int;
  gone int;
BEGIN
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin';
  SELECT w."id" INTO team_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'team';
  IF admin_ws IS NULL THEN RETURN; END IF;
  SELECT u."role" INTO r FROM auth.users u WHERE u."id" = login;
  IF EXISTS (SELECT 1 FROM "public"."archive_client_logins" a WHERE a."login_id" = login) THEN
    r := NULL;
  END IF;
  -- Into the workspaces the role gives (Moderator in each).
  INSERT INTO "public"."workspace_users" ("workspace_id", "login_id", "moderator")
  SELECT x.ws, login, true
    FROM (VALUES (admin_ws, r = 'admin'), (team_ws, r IN ('admin', 'member'))) AS x(ws, want)
   WHERE x.ws IS NOT NULL AND coalesce(x.want, false)
  ON CONFLICT ("workspace_id", "login_id") DO UPDATE SET "moderator" = true
   WHERE NOT "workspace_users"."moderator";
  GET DIAGNOSTICS changed = ROW_COUNT;
  -- Out of the ones it no longer gives.
  DELETE FROM "public"."workspace_users" u
   WHERE u."login_id" = login
     AND ((u."workspace_id" = admin_ws AND coalesce(r, '') <> 'admin')
          OR (u."workspace_id" = team_ws AND coalesce(r, '') NOT IN ('admin', 'member')));
  GET DIAGNOSTICS gone = ROW_COUNT;
  IF changed + gone > 0 THEN
    INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
    VALUES (admin_ws, NULL, 'bridge.login', jsonb_build_object('login', login, 'role', r));
  END IF;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_login"(uuid) FROM PUBLIC;
--> statement-breakpoint

-- ── 1c. A former client gets no private workspace (W8a fix round 2) ────────

-- A brain switched by hand after its clients were set up
-- (mantle.ws_former_clients = 'reviewed', above) runs the review homes
-- (0264) and the spaces fold (0267). Both made a private workspace, "<name>
-- (only you)", with its login a Moderator, for every login whose space held
-- an item, a former client included. Here a login archive_client_logins
-- names is a login that is gone, as a deleted one is: it never gets a
-- private workspace, and its items go to its Former user workspace (no
-- users; keyed by its id, as a deleted login's while an archive row names
-- it). The three functions are 0264's and 0267's with only that change; the
-- released migrations are not edited. No row changes here: they act when
-- they run (a switch, the boot step, an app create).
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
           -- A former client (archive_client_logins, 0272) is a login that is
           -- gone here: no private workspace, its Former user workspace
           -- (keyed by its id, below) instead.
           CASE WHEN EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc
                              WHERE fc."login_id" = CASE WHEN s."kind" = 'personal' THEN s."login_id"
                                                         ELSE si."author_login_id" END)
                THEN NULL
                WHEN s."kind" = 'personal' THEN s."login_id" ELSE si."author_login_id" END,
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
         AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = i."home_login")
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
          -- A former client counts as a login that is gone (0272).
          LEFT JOIN auth.users u ON u."id" = i."space_login"
                                AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = i."space_login")
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
-- A login's private workspace (21.8 row 8, plan 15): its own, made now
-- when it has none (or only an archived one), "<name> (only you)", the
-- login its only user and Moderator. NULL for a login that does not exist,
-- is disabled, was a client (archive_client_logins, 0272), or on a brain
-- not on workspaces. The app calls it on the
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
     OR EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = login)
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
  -- A former client (archive_client_logins, 0272) is a login that is gone:
  -- never its private workspace, its Former user workspace (keyed by its
  -- id, as mantle_ws_review_off keys it) instead.
  UPDATE pg_temp."ws_fold" f SET "home" = p."workspace_id"
    FROM "public"."private_workspaces" p
   WHERE f."home" IS NULL AND p."login_id" = f."login_id"
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = f."login_id");
  UPDATE pg_temp."ws_fold" f SET "home" = fw."workspace_id"
    FROM "public"."former_user_workspaces" fw
   WHERE f."home" IS NULL AND fw."former_key" = f."login_id"
     AND EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = f."login_id");
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
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = f."login_id")
     AND EXISTS (SELECT 1 FROM "public"."workspaces" a
                  WHERE a."id" = f."home" AND a."archived_at" IS NOT NULL);
  UPDATE pg_temp."ws_fold" f SET "home" = p."workspace_id"
    FROM "public"."private_workspaces" p
   WHERE p."login_id" = f."login_id" AND f."home" IS NOT NULL AND f."home" <> p."workspace_id"
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u."id" = f."login_id")
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = f."login_id")
     AND EXISTS (SELECT 1 FROM "public"."workspaces" a
                  WHERE a."id" = f."home" AND a."archived_at" IS NOT NULL);
  UPDATE pg_temp."ws_fold" f SET "home" = NULL
   WHERE f."home" IS NOT NULL
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u."id" = f."login_id")
     AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = f."login_id")
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
                         ON p."workspace_id" = f."home" AND p."login_id" = f."login_id"
                      WHERE NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = f."login_id"))
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
       AND NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = f."login_id")
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
  -- A former client's Former user workspace, keyed by its id.
  FOR r IN
    SELECT DISTINCT f."login_id" AS former FROM pg_temp."ws_fold" f
     WHERE f."home" IS NULL AND EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = f."login_id")
     ORDER BY 1
  LOOP
    INSERT INTO "public"."workspaces" ("owner_id", "name", "description")
    VALUES (brain, 'Former user', 'The work of a login that was removed. It has no users; an Admin user may join it.')
    RETURNING "id" INTO ws;
    INSERT INTO "public"."former_user_workspaces" ("former_key", "workspace_id") VALUES (r.former, ws);
    INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
    VALUES (ws, NULL, 'review_off.former', '{}'::jsonb);
    UPDATE pg_temp."ws_fold" f SET "home" = ws WHERE f."home" IS NULL AND f."login_id" = r.former;
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
  -- Every author reaches every item of its space (its private workspace);
  -- a former client reaches none (0272).
  SELECT count(*) INTO bad
    FROM pg_temp."ws_fold" f JOIN "public"."nodes" n ON n."id" = f."node_id"
    JOIN auth.users u ON u."id" = f."login_id"
   WHERE NOT EXISTS (SELECT 1 FROM "public"."archive_client_logins" fc WHERE fc."login_id" = f."login_id")
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_users" wu
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

-- ── 2. The email-code sign-in and the static login tokens ───────────────────

DO $$
DECLARE
  src int;
  kept int;
BEGIN
  IF to_regclass('public.client_signin_codes') IS NOT NULL THEN
    INSERT INTO "public"."archive_client_signin_codes"
           ("id", "owner_id", "login_id", "kind", "expires_at", "attempts", "used_at",
            "revoked_at", "sent_at", "send_error", "created_by", "created_at")
    SELECT c."id", c."owner_id", c."login_id", c."kind", c."expires_at", c."attempts", c."used_at",
           c."revoked_at", c."sent_at", c."send_error", c."created_by", c."created_at"
      FROM "public"."client_signin_codes" c
    ON CONFLICT ("id") DO NOTHING;
    SELECT count(*) INTO src FROM "public"."client_signin_codes";
    SELECT count(*) INTO kept FROM "public"."client_signin_codes" c
      JOIN "public"."archive_client_signin_codes" a ON a."id" = c."id";
    IF kept <> src THEN
      RAISE EXCEPTION '0272: archived % of % client sign-in codes', kept, src;
    END IF;
    DROP TABLE "public"."client_signin_codes" RESTRICT;
  END IF;

  IF to_regclass('public.client_signin_code_skips') IS NOT NULL THEN
    INSERT INTO "public"."archive_client_signin_code_skips" ("id", "reason", "created_at")
    SELECT s."id", s."reason", s."created_at" FROM "public"."client_signin_code_skips" s
    ON CONFLICT ("id") DO NOTHING;
    SELECT count(*) INTO src FROM "public"."client_signin_code_skips";
    SELECT count(*) INTO kept FROM "public"."client_signin_code_skips" s
      JOIN "public"."archive_client_signin_code_skips" a ON a."id" = s."id";
    IF kept <> src THEN
      RAISE EXCEPTION '0272: archived % of % skipped code requests', kept, src;
    END IF;
    DROP TABLE "public"."client_signin_code_skips" RESTRICT;
  END IF;

  IF to_regclass('public.client_signin_sender_folders') IS NOT NULL THEN
    INSERT INTO "public"."archive_client_signin_sender_folders" ("account_id", "folders", "updated_at")
    SELECT f."account_id", f."folders", f."updated_at" FROM "public"."client_signin_sender_folders" f
    ON CONFLICT ("account_id") DO NOTHING;
    SELECT count(*) INTO src FROM "public"."client_signin_sender_folders";
    SELECT count(*) INTO kept FROM "public"."client_signin_sender_folders" f
      JOIN "public"."archive_client_signin_sender_folders" a ON a."account_id" = f."account_id";
    IF kept <> src THEN
      RAISE EXCEPTION '0272: archived % of % sign-in sender folder rows', kept, src;
    END IF;
    DROP TABLE "public"."client_signin_sender_folders" RESTRICT;
  END IF;

  IF to_regclass('public.mcp_login_tokens') IS NOT NULL THEN
    INSERT INTO "public"."archive_mcp_login_tokens"
           ("id", "login_id", "label", "session_epoch", "created_by", "last_used_at",
            "revoked_at", "created_at")
    SELECT t."id", t."login_id", t."label", t."session_epoch", t."created_by", t."last_used_at",
           t."revoked_at", t."created_at"
      FROM "public"."mcp_login_tokens" t
    ON CONFLICT ("id") DO NOTHING;
    SELECT count(*) INTO src FROM "public"."mcp_login_tokens";
    SELECT count(*) INTO kept FROM "public"."mcp_login_tokens" t
      JOIN "public"."archive_mcp_login_tokens" a ON a."id" = t."id";
    IF kept <> src THEN
      RAISE EXCEPTION '0272: archived % of % static login tokens', kept, src;
    END IF;
    DROP TABLE "public"."mcp_login_tokens" RESTRICT;
  END IF;
END
$$;
--> statement-breakpoint

-- ── 3. The role a key or a peer was made under ──────────────────────────────

DO $$
DECLARE
  src int;
  kept int;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'access_keys'
                AND column_name = 'login_role') THEN
    -- A key whose login's role changed after it was made was refused by the
    -- role check; with the check gone it would work again, so it ends here.
    -- (A role change revokes the login's keys in the app already: this only
    -- catches a row that slipped past.)
    EXECUTE $q$
      UPDATE "public"."access_keys" k SET "revoked_at" = now()
        FROM auth.users u
       WHERE k."login_id" = u."id" AND k."revoked_at" IS NULL AND k."login_role" <> u."role"$q$;
    EXECUTE $q$
      INSERT INTO "public"."archive_key_roles" ("key_id", "login_role")
      SELECT k."id", k."login_role" FROM "public"."access_keys" k
      ON CONFLICT ("key_id") DO NOTHING$q$;
    SELECT count(*) INTO src FROM "public"."access_keys";
    SELECT count(*) INTO kept FROM "public"."access_keys" k
      JOIN "public"."archive_key_roles" a ON a."key_id" = k."id";
    IF kept <> src THEN
      RAISE EXCEPTION '0272: archived the role of % of % keys', kept, src;
    END IF;
    ALTER TABLE "public"."access_keys" DROP CONSTRAINT IF EXISTS "access_keys_role_ck";
    ALTER TABLE "public"."access_keys" DROP CONSTRAINT IF EXISTS "access_keys_risky_ck";
    ALTER TABLE "public"."access_keys" DROP CONSTRAINT IF EXISTS "access_keys_client_epoch_ck";
    ALTER TABLE "public"."access_keys" DROP COLUMN "login_role" RESTRICT;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'mantle_peers'
                AND column_name = 'acts_as_role') THEN
    -- A peer whose login's role changed after it was bound was refused by
    -- the role check: it is unbound (and its rebind restores nothing).
    EXECUTE $q$
      UPDATE "public"."mantle_peers" p
         SET "acts_as_login_id" = NULL, "write_enabled" = false,
             "allowed_risky_tools" = '{}'::text[], "updated_at" = now()
        FROM auth.users u
       WHERE p."acts_as_login_id" = u."id"
         AND p."acts_as_role" IS DISTINCT FROM u."role"$q$;
    EXECUTE $q$
      INSERT INTO "public"."archive_peer_roles" ("peer_id", "acts_as_role", "ended_acts_as_role")
      SELECT p."id", p."acts_as_role", p."ended_acts_as_role" FROM "public"."mantle_peers" p
      ON CONFLICT ("peer_id") DO NOTHING$q$;
    SELECT count(*) INTO src FROM "public"."mantle_peers";
    SELECT count(*) INTO kept FROM "public"."mantle_peers" p
      JOIN "public"."archive_peer_roles" a ON a."peer_id" = p."id";
    IF kept <> src THEN
      RAISE EXCEPTION '0272: archived the role of % of % peers', kept, src;
    END IF;
    ALTER TABLE "public"."mantle_peers" DROP CONSTRAINT IF EXISTS "mantle_peers_acts_as_role_ck";
    ALTER TABLE "public"."mantle_peers" DROP CONSTRAINT IF EXISTS "mantle_peers_ended_acts_as_role_ck";
    ALTER TABLE "public"."mantle_peers" DROP COLUMN "acts_as_role" RESTRICT;
    ALTER TABLE "public"."mantle_peers" DROP COLUMN "ended_acts_as_role" RESTRICT;
  END IF;
END
$$;
--> statement-breakpoint
-- The former clients' private workspaces become their Former user
-- workspaces (W8 integration), on a brain on workspaces: the rename, the
-- scrub of the name and description from the workspace's events, and the
-- registration, as mantle_ws_review_off does for a deleted login's private
-- workspace. Done here because a migrated box never runs the review homes
-- again. Each archived row whose workspace is still unregistered: a second
-- run finds none. Should the login have a Former user workspace already, the
-- orphan is renamed and archived, as there. Grants and items do not change:
-- the workspace stays their home.
DO $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  r record;
  made bigint := 0;
  scrubbed bigint := 0;
  scrub_n bigint;
BEGIN
  IF brain IS NULL OR NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                                   WHERE w."owner_id" = brain AND w."is_admin") THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT a."workspace_id" AS ws, a."login_id" AS former
      FROM "public"."archive_client_private_workspaces" a
      JOIN "public"."workspaces" w ON w."id" = a."workspace_id"
     WHERE w."owner_id" = brain
       AND NOT EXISTS (SELECT 1 FROM "public"."private_workspaces" p WHERE p."workspace_id" = w."id")
       AND NOT EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f WHERE f."workspace_id" = w."id")
       AND NOT EXISTS (SELECT 1 FROM "public"."workspace_events" e2
                        WHERE e2."workspace_id" = w."id" AND e2."action" = 'review_off.former_renamed')
     ORDER BY a."workspace_id"
  LOOP
    UPDATE "public"."workspaces"
       SET "name" = 'Former user',
           "description" = 'The work of a login that was removed. It has no users; an Admin user may join it.',
           "updated_at" = now()
     WHERE "id" = r.ws;
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
    made := made + 1;
  END LOOP;
  IF made > 0 THEN
    RAISE NOTICE '0272: % former client private workspaces made Former user (% events scrubbed)',
      made, scrubbed;
  END IF;
END
$$;
