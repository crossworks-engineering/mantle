-- Workspaces W7c: each user has their own chat thread with each workspace
-- assistant, and team_messages folds into assistant_messages (plan page
-- 4887b8e7, sections 4, 5.2, 11 (W7) and the owner's answer of 2026-10-11:
-- Admin users no longer read other users' chats; each user reads only their
-- own threads, the owner's too).
--
--  - A chat row with no login was the anchor's (the owner's): rows from
--    before R3 (0250) and turns that answered no login (a heartbeat, an
--    owner Telegram bot). They are stamped with the anchor login, and the
--    stamp trigger now does the same for a new row that names no login, so
--    no chat row is left without one. Conversation digests and archived chat
--    summaries of the anchor's threads take the anchor login too
--    (nodes.login_id and data.login_id): a digest is read only by the login
--    whose turns it summarises.
--  - Every member login's team_messages row is copied into assistant_messages
--    with the same id, as a row of the Team workspace's assistant (channel
--    web, the Team workspace, the login): the member's thread is now an
--    ordinary per-(agent, login) thread. A team-portal contact's rows (no
--    login) are history only: copied to archive_team_messages. team_messages
--    is frozen (no insert, no update) and stays until W8.
--  - Row security: a thread or a message is read by its own login only, in a
--    scope that holds its workspace. The "no login is Admin's" rule of 0254
--    goes (no row is left without a login).
--  - At most one open thread per (agent, login), not per agent.
--  - A finished reply in a non-anchor login's thread raises the login_notice
--    the member's phone listens to (it rode team_messages before).
--
-- No LLM work and no queue row. The copy fires no summarize_due and no
-- conversation_changed: both notify functions stay quiet in a transaction
-- that sets mantle.conversation_notify = off (this one does; nothing else
-- does), and every copied row is marked data.digest_skip, which the
-- summarizer never digests (its threshold count skips them too). The
-- setting is honoured only for a role that owns the chat tables (the
-- migration's): a scoped viewer role cannot silence its own writes with it.
-- The backfills are UPDATEs, which neither notify fires on. node_ingested
-- fires on INSERT of nodes only; this migration inserts no node.
--
-- Re-runnable: every step either replaces what it made or skips what is
-- already there, so a second run changes nothing.

SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- All four tables in one statement with a short wait and a retry, like 0254:
-- waiting on one while holding the others would stall every reader.
DO $$
DECLARE
  attempt int := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      LOCK TABLE "public"."assistant_messages", "public"."chat_threads",
                 "public"."team_messages", "public"."assistant_read_cursors"
        IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= 20 THEN
        RAISE EXCEPTION '0269: the tables stayed busy for 20 attempts; run the migration again at a quieter time'
          USING ERRCODE = 'lock_not_available';
      END IF;
      RAISE NOTICE '0269: tables busy (attempt %), retrying', attempt;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END
$$;
--> statement-breakpoint

-- ── The notify guards ─────────────────────────────────────────────────────────
-- Quiet only where a transaction asks (this migration), and only for a role
-- that owns assistant_messages (the migration's role): a scoped viewer role
-- that sets the same setting is not quiet. The payload of
-- conversation_changed now names the login, so a stream tells each login
-- about its own thread only.
CREATE OR REPLACE FUNCTION "public"."mantle_conversation_quiet"()
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = "public", pg_temp AS $$
  SELECT coalesce(current_setting('mantle.conversation_notify', true), '') = 'off'
     AND pg_has_role(
           current_user,
           (SELECT c.relowner FROM pg_catalog.pg_class c
             WHERE c.oid = '"public"."assistant_messages"'::regclass),
           'MEMBER')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."notify_summarize_due"() RETURNS trigger AS $$
BEGIN
  IF new.agent_id IS NOT NULL
     AND NOT "public"."mantle_conversation_quiet"() THEN
    PERFORM pg_notify('summarize_due', new.agent_id::text);
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."notify_conversation_changed"() RETURNS trigger AS $$
BEGIN
  IF (tg_op = 'UPDATE' AND new.status IS NOT DISTINCT FROM old.status) THEN
    RETURN new;
  END IF;
  IF "public"."mantle_conversation_quiet"() THEN
    RETURN new;
  END IF;
  PERFORM pg_notify(
    'conversation_changed',
    json_build_object(
      'ownerId', new.owner_id,
      'agentSlug', (SELECT slug FROM "public"."agents" WHERE id = new.agent_id),
      'direction', new.direction,
      'status', new.status,
      'loginId', new.login_id
    )::text
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_notify_login_chat"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF "public"."mantle_conversation_quiet"() THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify(
    'login_notice',
    json_build_object('kind', 'chat', 'loginId', new.login_id, 'id', new.id)::text
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_notify_login_chat"() FROM PUBLIC;
--> statement-breakpoint
SELECT set_config('mantle.conversation_notify', 'off', true);
--> statement-breakpoint

-- ── A chat row always names its login ─────────────────────────────────────────
-- The 0250 stamp, with one more fallback for the chat tables: a message or a
-- thread that names no login, in a transaction that names none, is the
-- anchor's (owner_id is the brain's anchor login).
CREATE OR REPLACE FUNCTION "public"."mantle_stamp_workspace_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  src record;
  d text;
BEGIN
  IF TG_TABLE_NAME = 'run_items' THEN
    SELECT r."workspace_id" AS ws, r."login_id" AS login INTO src
      FROM "public"."runs" r WHERE r."id" = NEW."run_id";
  ELSIF TG_TABLE_NAME IN ('tool_results', 'pending_tool_calls') THEN
    SELECT t."workspace_id" AS ws, t."login_id" AS login INTO src
      FROM "public"."traces" t WHERE t."id" = NEW."trace_id";
    IF NOT FOUND AND TG_TABLE_NAME = 'pending_tool_calls' THEN
      SELECT a."workspace_id" AS ws, NULL::uuid AS login INTO src
        FROM "public"."agents" a WHERE a."id" = NEW."agent_id";
    END IF;
  ELSE
    SELECT a."workspace_id" AS ws, NULL::uuid AS login INTO src
      FROM "public"."agents" a WHERE a."id" = NEW."agent_id";
  END IF;
  IF FOUND THEN
    NEW."workspace_id" := coalesce(NEW."workspace_id", src.ws);
    NEW."login_id" := coalesce(NEW."login_id", src.login);
  END IF;
  -- A trace names the login it served in its data (team turns do).
  IF TG_TABLE_NAME = 'traces' AND NEW."login_id" IS NULL THEN
    d := NEW."data"->>'login_id';
    IF d ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW."login_id" := d::uuid;
    END IF;
  END IF;
  NEW."login_id" := coalesce(NEW."login_id", "public"."mantle_login_id"());
  IF TG_TABLE_NAME IN ('assistant_messages', 'chat_threads') THEN
    NEW."login_id" := coalesce(NEW."login_id", NEW."owner_id");
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_stamp_workspace_trg"() FROM PUBLIC;
--> statement-breakpoint

-- ── Backfill: no login is the anchor's ───────────────────────────────────────
-- UPDATEs of login_id only: neither conversation notify fires on them.
UPDATE "public"."assistant_messages" SET "login_id" = "owner_id" WHERE "login_id" IS NULL;
--> statement-breakpoint
UPDATE "public"."chat_threads" SET "login_id" = "owner_id" WHERE "login_id" IS NULL;
--> statement-breakpoint
-- The digests and archived chat summaries of those threads: per login like
-- the turns they summarise (nodes.login_id is the per-login read rule, 0241).
-- A login change rewrites the node's chunk, window and fact copies under its
-- head; the named bypass covers this migration's heads. updated_at is kept
-- (mantle.keep_updated_at, 0247): a fresh one would put a digest the
-- extractor skipped back in its drain window.
DO $$
BEGIN
  PERFORM "public"."mantle_heads_bypass"('0269_workspaces_user_threads');
  PERFORM set_config('mantle.keep_updated_at', 'on', true);
  UPDATE "public"."nodes" n
     SET "login_id" = coalesce(
           CASE WHEN n."data"->>'login_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (n."data"->>'login_id')::uuid END,
           n."owner_id"),
         "data" = n."data" || jsonb_build_object('login_id', coalesce(n."data"->>'login_id', n."owner_id"::text))
   WHERE n."type" = 'note'
     AND (n."tags" @> ARRAY['conversation-digest']::text[] OR n."tags" @> ARRAY['chat-archive']::text[])
     AND (n."login_id" IS NULL OR n."data"->>'login_id' IS NULL)
     AND n."owner_id" = "public"."mantle_brain_id"();
  PERFORM set_config('mantle.keep_updated_at', '', true);
END
$$;
--> statement-breakpoint

-- ── team_messages folds in ───────────────────────────────────────────────────
-- A member login's rows: the same id, the Team workspace's assistant (else
-- the row's own agent), channel web, the Team workspace, the login. Already
-- digested (data.digest_skip): the summarizer never bills them. What only a
-- team row had rides in data: its trace, its private-read mark and its
-- channel. A second run copies nothing (the ids are there).
-- A row whose agent is gone, on a brain whose Team workspace has no
-- assistant, still lands in the Team workspace (the bridge workspace, W7
-- integration fix 2), never in none: a row with no workspace reads as
-- Admin's, and its member would lose it.
INSERT INTO "public"."assistant_messages"
  ("id", "owner_id", "direction", "text", "agent_id", "model", "channel", "attachments",
   "data", "status", "error", "created_at", "workspace_id", "login_id")
SELECT tm."id", tm."owner_id", tm."direction", tm."text",
       coalesce(team."agent_id", tm."agent_id"), tm."model", 'web', tm."attachments",
       jsonb_strip_nulls(jsonb_build_object(
         'folded_from', 'team_messages',
         'digest_skip', true,
         'trace_id', tm."trace_id",
         'used_private', CASE WHEN tm."used_private" THEN true END,
         'team_channel', CASE WHEN tm."channel" <> 'web' THEN tm."channel" END)),
       tm."status", tm."error", tm."created_at",
       coalesce(team."ws_id",
                (SELECT a."workspace_id" FROM "public"."agents" a WHERE a."id" = tm."agent_id"),
                (SELECT w."id" FROM "public"."workspaces" w
                  WHERE w."owner_id" = tm."owner_id" AND w."bridge_key" = 'team'
                  ORDER BY w."archived_at" NULLS FIRST LIMIT 1)),
       tm."login_id"
  FROM "public"."team_messages" tm
  LEFT JOIN LATERAL (
    SELECT w."id" AS ws_id, a."id" AS agent_id
      FROM "public"."workspaces" w
      JOIN "public"."workspace_resources" r
        ON r."workspace_id" = w."id" AND r."type" = 'assistant'
      JOIN "public"."agents" a ON a."id"::text = r."ref_id" AND a."owner_id" = tm."owner_id"
     WHERE w."owner_id" = tm."owner_id" AND w."bridge_key" = 'team'
     ORDER BY w."archived_at" NULLS FIRST, a."enabled" DESC
     LIMIT 1
  ) team ON true
 WHERE tm."login_id" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- The same for a row an earlier run folded with no workspace (re-runnable):
-- it moves to the Team bridge workspace when the brain has one.
UPDATE "public"."assistant_messages" m
   SET "workspace_id" = (SELECT w."id" FROM "public"."workspaces" w
                          WHERE w."owner_id" = m."owner_id" AND w."bridge_key" = 'team'
                          ORDER BY w."archived_at" NULLS FIRST LIMIT 1)
 WHERE m."data" ->> 'folded_from' = 'team_messages'
   AND m."workspace_id" IS NULL
   AND m."agent_id" IS NULL
   AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                WHERE w."owner_id" = m."owner_id" AND w."bridge_key" = 'team');
--> statement-breakpoint

-- A team-portal contact's rows (no login): history only, never a thread.
-- Columns spelled out (not LIKE): a copied NOT NULL keeps team_messages'
-- constraint names, which a restore then hands to the wrong table.
CREATE TABLE IF NOT EXISTS "public"."archive_team_messages" (
  "id" uuid PRIMARY KEY,
  "owner_id" uuid NOT NULL,
  "contact_id" uuid,
  "direction" text NOT NULL,
  "text" text NOT NULL,
  "agent_id" uuid,
  "model" text,
  "channel" text NOT NULL,
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "trace_id" uuid,
  "status" text NOT NULL,
  "error" text,
  "login_id" uuid,
  "used_private" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL,
  "archived_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "public"."archive_team_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "public"."archive_team_messages" FROM PUBLIC;
--> statement-breakpoint
INSERT INTO "public"."archive_team_messages"
  ("id", "owner_id", "contact_id", "direction", "text", "agent_id", "model", "channel",
   "attachments", "trace_id", "status", "error", "login_id", "used_private", "created_at")
SELECT tm."id", tm."owner_id", tm."contact_id", tm."direction", tm."text", tm."agent_id",
       tm."model", tm."channel", tm."attachments", tm."trace_id", tm."status", tm."error",
       tm."login_id", tm."used_private", tm."created_at"
  FROM "public"."team_messages" tm
 WHERE tm."login_id" IS NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- team_messages is frozen: nothing writes it again. A delete still cascades
-- from its contact or login, and a deleted agent still nulls agent_id (the
-- foreign key's own SET NULL, the one update let through). W8 drops it.
CREATE OR REPLACE FUNCTION "public"."mantle_team_messages_frozen_trg"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."agent_id" IS NULL
     AND (to_jsonb(NEW) - 'agent_id') = (to_jsonb(OLD) - 'agent_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'team_messages is frozen since 0269: chat rows live in assistant_messages'
    USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "team_messages_frozen_trg" ON "public"."team_messages";
--> statement-breakpoint
CREATE TRIGGER "team_messages_frozen_trg"
  BEFORE INSERT OR UPDATE ON "public"."team_messages"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_team_messages_frozen_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "team_messages_login_notice_ins_trg" ON "public"."team_messages";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "team_messages_login_notice_upd_trg" ON "public"."team_messages";
--> statement-breakpoint

-- ── Read cursors per (agent, login) ───────────────────────────────────────────
-- The inbox's unread count was per agent; it is per thread now. A cursor
-- with no login was the anchor's.
ALTER TABLE "public"."assistant_read_cursors" ADD COLUMN IF NOT EXISTS "login_id" uuid;
--> statement-breakpoint
UPDATE "public"."assistant_read_cursors" SET "login_id" = "owner_id" WHERE "login_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "public"."assistant_read_cursors" ALTER COLUMN "login_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."assistant_read_cursors" DROP CONSTRAINT IF EXISTS "assistant_read_cursors_owner_id_agent_id_pk";
--> statement-breakpoint
ALTER TABLE "public"."assistant_read_cursors" DROP CONSTRAINT IF EXISTS "assistant_read_cursors_pkey";
--> statement-breakpoint
-- A second run: the key this migration added is replaced, not added twice.
ALTER TABLE "public"."assistant_read_cursors" DROP CONSTRAINT IF EXISTS "assistant_read_cursors_owner_agent_login_pk";
--> statement-breakpoint
ALTER TABLE "public"."assistant_read_cursors"
  ADD CONSTRAINT "assistant_read_cursors_owner_agent_login_pk" PRIMARY KEY ("owner_id", "agent_id", "login_id");
--> statement-breakpoint

-- ── One thread per (agent, login) ─────────────────────────────────────────────
DROP INDEX IF EXISTS "public"."chat_threads_one_open_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_threads_one_open_uq"
  ON "public"."chat_threads" ("owner_id", "agent_id", "login_id") WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_messages_owner_agent_login_created_idx"
  ON "public"."assistant_messages" ("owner_id", "agent_id", "login_id", "created_at");
--> statement-breakpoint

-- ── Row security: own login only ─────────────────────────────────────────────
DROP POLICY IF EXISTS "assistant_messages_user_read" ON "public"."assistant_messages";
--> statement-breakpoint
CREATE POLICY "assistant_messages_user_read" ON "public"."assistant_messages"
  FOR SELECT TO mantle_view_user USING (
    (CASE WHEN "workspace_id" IS NULL THEN (SELECT "public"."mantle_scope_is_admin"())
          ELSE "workspace_id" = ANY ((SELECT "public"."mantle_scope_ws"())::uuid[]) END)
    AND "login_id" = (SELECT "public"."mantle_login_id"()));
--> statement-breakpoint
DROP POLICY IF EXISTS "chat_threads_user_read" ON "public"."chat_threads";
--> statement-breakpoint
CREATE POLICY "chat_threads_user_read" ON "public"."chat_threads"
  FOR SELECT TO mantle_view_user USING (
    (CASE WHEN "workspace_id" IS NULL THEN (SELECT "public"."mantle_scope_is_admin"())
          ELSE "workspace_id" = ANY ((SELECT "public"."mantle_scope_ws"())::uuid[]) END)
    AND "login_id" = (SELECT "public"."mantle_login_id"()));
--> statement-breakpoint

-- ── The member's phone hears its own replies ──────────────────────────────────
-- A finished reply in a thread that is not the anchor's (the owner's own
-- replies reach the owner's devices by conversation_changed, as before).
DROP TRIGGER IF EXISTS "assistant_messages_login_notice_ins_trg" ON "public"."assistant_messages";
--> statement-breakpoint
CREATE TRIGGER "assistant_messages_login_notice_ins_trg"
  AFTER INSERT ON "public"."assistant_messages"
  FOR EACH ROW
  WHEN (new.direction = 'outbound' AND new.status = 'complete'
        AND new.login_id IS NOT NULL AND new.login_id IS DISTINCT FROM new.owner_id)
  EXECUTE FUNCTION "public"."mantle_notify_login_chat"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "assistant_messages_login_notice_upd_trg" ON "public"."assistant_messages";
--> statement-breakpoint
CREATE TRIGGER "assistant_messages_login_notice_upd_trg"
  AFTER UPDATE OF "status" ON "public"."assistant_messages"
  FOR EACH ROW
  WHEN (new.direction = 'outbound' AND new.status = 'complete'
        AND old.status IS DISTINCT FROM 'complete'
        AND new.login_id IS NOT NULL AND new.login_id IS DISTINCT FROM new.owner_id)
  EXECUTE FUNCTION "public"."mantle_notify_login_chat"();
--> statement-breakpoint

-- The proof, in the transaction (23514 rolls everything back): every member
-- login's team row is in assistant_messages, and no chat row is left
-- without a login.
DO $$
DECLARE
  missing bigint;
  loose bigint;
BEGIN
  SELECT count(*) INTO missing FROM "public"."team_messages" tm
   WHERE tm."login_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "public"."assistant_messages" m
                      WHERE m."id" = tm."id" AND m."login_id" = tm."login_id");
  SELECT (SELECT count(*) FROM "public"."assistant_messages" WHERE "login_id" IS NULL)
       + (SELECT count(*) FROM "public"."chat_threads" WHERE "login_id" IS NULL)
    INTO loose;
  IF missing > 0 OR loose > 0 THEN
    RAISE EXCEPTION '0269: % team rows not folded, % chat rows without a login', missing, loose
      USING ERRCODE = '23514';
  END IF;
END
$$;
