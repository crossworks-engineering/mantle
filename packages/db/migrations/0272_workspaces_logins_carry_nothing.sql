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
--    switched off. Then its role becomes member, and the role CHECK admits
--    admin and member only. The row stays: what it wrote keeps its author.
--    Nobody is added to a workspace, and no notify fires (the role and
--    disable triggers on auth.users are off for that one UPDATE).
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
                 "public"."oauth_auth_codes", "public"."oauth_access_tokens"
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
  FOREACH t IN ARRAY ARRAY['archive_client_logins', 'archive_client_signin_codes',
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
-- lib/peer-unbind.ts does) and switched off.
UPDATE "public"."mantle_peers" p
   SET "ended_acts_as_login_id" = p."acts_as_login_id",
       "acts_as_login_id" = NULL,
       "enabled" = false,
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
