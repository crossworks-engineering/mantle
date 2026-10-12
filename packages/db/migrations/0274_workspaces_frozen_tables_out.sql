-- Workspaces W8d: the frozen chat and client tables go (plan page 4887b8e7,
-- section 11, W8 row; owner rules: archive before every drop, a count
-- mismatch raises, drops are RESTRICT, never CASCADE).
--
--  - team_messages, frozen since 0269: every row was copied there, a member
--    login's to assistant_messages and a team-portal contact's to
--    archive_team_messages, with the same id. A row in neither (W8
--    integration: a login's row whose copy went when its assistant was
--    deleted with its conversation, `?conversation=delete`) is copied to
--    archive_team_messages first, counted. Then every row is proved kept
--    (a row in neither raises and the whole migration rolls back), and the
--    table and its frozen trigger's function are dropped.
--  - team_read_cursors (the owner's read cursor of the old portal threads),
--    team_notifications (member notifications, unused since the forum went),
--    login_chat_read_cursors (a member's own unread count, replaced by
--    assistant_read_cursors in 0269), client_report_acks (the "what clients
--    see" acknowledgements) and client_quota_refusals (the client quota
--    log): each is archived (archive_<name>, every column, plus
--    archived_at), counted against what it copied, then dropped. The
--    team_notifications notify function goes with its triggers.
--
-- Nothing else changes. The spaces family (spaces, space_items,
-- space_submissions, space_item_bundles, space_uploads, accepted_snapshots)
-- stays until W10. No LLM work is queued and no notify fires: the archives
-- are plain inserts into tables with no trigger, and a drop fires nothing.
--
-- Re-runnable: the archives are CREATE IF NOT EXISTS and their inserts ON
-- CONFLICT DO NOTHING; each step runs only while its table is still there,
-- so a second run changes nothing.
--
-- The `when` sits above 1790195640000 (0273's, W8c): migrate.ts skips a
-- migration whose `when` is at or below the highest one applied.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- The tables this migration drops, in one statement with a short wait and a
-- retry, like 0269 and 0272: waiting on one while holding the others would
-- stall every reader. A table already gone (a second run) is skipped.
DO $$
DECLARE
  attempt int := 0;
  t text;
  droppable CONSTANT text[] := ARRAY[
    'public.team_messages', 'public.team_read_cursors', 'public.team_notifications',
    'public.login_chat_read_cursors', 'public.client_report_acks',
    'public.client_quota_refusals'];
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      FOREACH t IN ARRAY droppable LOOP
        IF to_regclass(t) IS NOT NULL THEN
          EXECUTE 'LOCK TABLE ' || t || ' IN ACCESS EXCLUSIVE MODE';
        END IF;
      END LOOP;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= 20 THEN
        RAISE EXCEPTION '0274: the tables stayed busy for 20 attempts; run the migration again at a quieter time'
          USING ERRCODE = 'lock_not_available';
      END IF;
      RAISE NOTICE '0274: tables busy (attempt %), retrying', attempt;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── The archives ─────────────────────────────────────────────────────────────
-- Columns spelled out (not LIKE): a copied NOT NULL keeps the source's
-- constraint names, which a restore then hands to the wrong table. No
-- foreign key: an archive row outlives what it named.

CREATE TABLE IF NOT EXISTS "public"."archive_team_read_cursors" (
  "owner_id"     uuid NOT NULL,
  "contact_id"   uuid NOT NULL,
  "last_read_at" timestamptz NOT NULL,
  "archived_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "contact_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_team_notifications" (
  "id"           uuid PRIMARY KEY,
  "owner_id"     uuid NOT NULL,
  "thread_id"    uuid NOT NULL,
  "recipient_id" uuid NOT NULL,
  "sender_id"    uuid NOT NULL,
  "sender_name"  text,
  "body"         text NOT NULL,
  "topic_id"     uuid,
  "post_id"      uuid,
  "read_at"      timestamptz,
  "created_at"   timestamptz NOT NULL,
  "archived_at"  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_login_chat_read_cursors" (
  "login_id"     uuid PRIMARY KEY,
  "last_read_at" timestamptz NOT NULL,
  "archived_at"  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_client_report_acks" (
  "id"          uuid PRIMARY KEY,
  "owner_id"    uuid NOT NULL,
  "acked_by"    uuid,
  "acked_at"    timestamptz NOT NULL,
  "item_ids"    uuid[] NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_client_quota_refusals" (
  "id"          uuid PRIMARY KEY,
  "login_id"    uuid,
  "reason"      text NOT NULL,
  "created_at"  timestamptz NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Admin pool and definer functions only (access-matrix.ts).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['archive_team_read_cursors', 'archive_team_notifications',
                           'archive_login_chat_read_cursors', 'archive_client_report_acks',
                           'archive_client_quota_refusals'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', 'public.' || quote_ident(t));
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', 'public.' || quote_ident(t));
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── team_messages: proved copied, then dropped ──────────────────────────────

DO $$
DECLARE
  total bigint;
  missing bigint;
  orphans bigint;
  copied bigint;
BEGIN
  IF to_regclass('public.team_messages') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $q$SELECT count(*) FROM "public"."team_messages"$q$ INTO total;
  -- A row in neither place (W8 integration): a login's row whose copy in
  -- assistant_messages went when its assistant was deleted with its
  -- conversation. Archived here before the proof, counted: the archive
  -- before every drop.
  EXECUTE $q$
    SELECT count(*) FROM "public"."team_messages" tm
     WHERE NOT EXISTS (SELECT 1 FROM "public"."assistant_messages" a WHERE a."id" = tm."id")
       AND NOT EXISTS (SELECT 1 FROM "public"."archive_team_messages" a WHERE a."id" = tm."id")$q$
    INTO orphans;
  IF orphans > 0 THEN
    EXECUTE $q$
      INSERT INTO "public"."archive_team_messages"
        ("id", "owner_id", "contact_id", "direction", "text", "agent_id", "model", "channel",
         "attachments", "trace_id", "status", "error", "login_id", "used_private", "created_at")
      SELECT tm."id", tm."owner_id", tm."contact_id", tm."direction", tm."text", tm."agent_id",
             tm."model", tm."channel", tm."attachments", tm."trace_id", tm."status", tm."error",
             tm."login_id", tm."used_private", tm."created_at"
        FROM "public"."team_messages" tm
       WHERE NOT EXISTS (SELECT 1 FROM "public"."assistant_messages" a WHERE a."id" = tm."id")
      ON CONFLICT ("id") DO NOTHING$q$;
    GET DIAGNOSTICS copied = ROW_COUNT;
    IF copied <> orphans THEN
      RAISE EXCEPTION '0274: archived % of % team_messages rows found in neither place', copied, orphans;
    END IF;
    RAISE NOTICE '0274: % team_messages rows in neither place archived', copied;
  END IF;
  -- Every row by its id: a login's row in assistant_messages, a contact's
  -- row (no login) in archive_team_messages (0269). A row in neither is a
  -- row the drop would lose.
  EXECUTE $q$
    SELECT count(*) FROM "public"."team_messages" tm
     WHERE NOT EXISTS (SELECT 1 FROM "public"."assistant_messages" a WHERE a."id" = tm."id")
       AND NOT EXISTS (SELECT 1 FROM "public"."archive_team_messages" a WHERE a."id" = tm."id")$q$
    INTO missing;
  IF missing > 0 THEN
    RAISE EXCEPTION '0274: % of % team_messages rows are in neither assistant_messages nor archive_team_messages', missing, total;
  END IF;
  DROP TABLE "public"."team_messages" RESTRICT;
  RAISE NOTICE '0274: team_messages (% rows, every one kept elsewhere) dropped', total;
END
$$;
--> statement-breakpoint
-- The frozen trigger's function went unused with its table (0269 made it).
DROP FUNCTION IF EXISTS "public"."mantle_team_messages_frozen_trg"() RESTRICT;
--> statement-breakpoint

-- ── The other frozen tables: archived, counted, dropped ─────────────────────

DO $$
DECLARE
  src bigint;
  kept bigint;
BEGIN
  IF to_regclass('public.team_read_cursors') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO "public"."archive_team_read_cursors" ("owner_id", "contact_id", "last_read_at")
      SELECT c."owner_id", c."contact_id", c."last_read_at" FROM "public"."team_read_cursors" c
      ON CONFLICT ("owner_id", "contact_id") DO NOTHING$q$;
    EXECUTE $q$SELECT count(*) FROM "public"."team_read_cursors"$q$ INTO src;
    EXECUTE $q$
      SELECT count(*) FROM "public"."team_read_cursors" c
        JOIN "public"."archive_team_read_cursors" a
          ON a."owner_id" = c."owner_id" AND a."contact_id" = c."contact_id"
         AND a."last_read_at" = c."last_read_at"$q$ INTO kept;
    IF kept <> src THEN
      RAISE EXCEPTION '0274: archived % of % team read cursors', kept, src;
    END IF;
    DROP TABLE "public"."team_read_cursors" RESTRICT;
  END IF;

  IF to_regclass('public.team_notifications') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO "public"."archive_team_notifications"
             ("id", "owner_id", "thread_id", "recipient_id", "sender_id", "sender_name", "body",
              "topic_id", "post_id", "read_at", "created_at")
      SELECT n."id", n."owner_id", n."thread_id", n."recipient_id", n."sender_id", n."sender_name",
             n."body", n."topic_id", n."post_id", n."read_at", n."created_at"
        FROM "public"."team_notifications" n
      ON CONFLICT ("id") DO NOTHING$q$;
    EXECUTE $q$SELECT count(*) FROM "public"."team_notifications"$q$ INTO src;
    EXECUTE $q$
      SELECT count(*) FROM "public"."team_notifications" n
        JOIN "public"."archive_team_notifications" a ON a."id" = n."id"$q$ INTO kept;
    IF kept <> src THEN
      RAISE EXCEPTION '0274: archived % of % team notifications', kept, src;
    END IF;
    DROP TABLE "public"."team_notifications" RESTRICT;
  END IF;

  IF to_regclass('public.login_chat_read_cursors') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO "public"."archive_login_chat_read_cursors" ("login_id", "last_read_at")
      SELECT c."login_id", c."last_read_at" FROM "public"."login_chat_read_cursors" c
      ON CONFLICT ("login_id") DO NOTHING$q$;
    EXECUTE $q$SELECT count(*) FROM "public"."login_chat_read_cursors"$q$ INTO src;
    EXECUTE $q$
      SELECT count(*) FROM "public"."login_chat_read_cursors" c
        JOIN "public"."archive_login_chat_read_cursors" a
          ON a."login_id" = c."login_id" AND a."last_read_at" = c."last_read_at"$q$ INTO kept;
    IF kept <> src THEN
      RAISE EXCEPTION '0274: archived % of % login chat read cursors', kept, src;
    END IF;
    DROP TABLE "public"."login_chat_read_cursors" RESTRICT;
  END IF;

  IF to_regclass('public.client_report_acks') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO "public"."archive_client_report_acks" ("id", "owner_id", "acked_by", "acked_at", "item_ids")
      SELECT r."id", r."owner_id", r."acked_by", r."acked_at", r."item_ids"
        FROM "public"."client_report_acks" r
      ON CONFLICT ("id") DO NOTHING$q$;
    EXECUTE $q$SELECT count(*) FROM "public"."client_report_acks"$q$ INTO src;
    EXECUTE $q$
      SELECT count(*) FROM "public"."client_report_acks" r
        JOIN "public"."archive_client_report_acks" a ON a."id" = r."id"$q$ INTO kept;
    IF kept <> src THEN
      RAISE EXCEPTION '0274: archived % of % client report acknowledgements', kept, src;
    END IF;
    DROP TABLE "public"."client_report_acks" RESTRICT;
  END IF;

  IF to_regclass('public.client_quota_refusals') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO "public"."archive_client_quota_refusals" ("id", "login_id", "reason", "created_at")
      SELECT q."id", q."login_id", q."reason", q."created_at" FROM "public"."client_quota_refusals" q
      ON CONFLICT ("id") DO NOTHING$q$;
    EXECUTE $q$SELECT count(*) FROM "public"."client_quota_refusals"$q$ INTO src;
    EXECUTE $q$
      SELECT count(*) FROM "public"."client_quota_refusals" q
        JOIN "public"."archive_client_quota_refusals" a ON a."id" = q."id"$q$ INTO kept;
    IF kept <> src THEN
      RAISE EXCEPTION '0274: archived % of % client quota refusals', kept, src;
    END IF;
    DROP TABLE "public"."client_quota_refusals" RESTRICT;
  END IF;
END
$$;
--> statement-breakpoint
-- The team_notifications notify function went unused with its triggers
-- (0140 made it).
DROP FUNCTION IF EXISTS "public"."notify_team_notification"() RESTRICT;
