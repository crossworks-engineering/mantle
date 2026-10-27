-- Messenger V1, Phase 1: the core store (plan page d8954876, sections 3, 4,
-- 7, 8, 11 and 20). Direct chats (two logins) and groups (any number of
-- logins, plus at most one agent from Phase 3) between the logins of one
-- brain. The chat with an assistant stays in assistant_messages; these
-- tables hold only people chats and groups.
--
--  - Every message of a conversation takes a seq (1, 2, 3) from the
--    conversation row, locked by the send (SELECT FOR UPDATE) in the same
--    transaction as the insert. Seq is the one order, the unread arithmetic
--    and the catch-up after a dropped connection. last_seq, last_message_at
--    and last_preview are written by that same transaction, never by a
--    trigger that could race.
--  - Who reads what is row security keyed by the participant row: a login
--    reads a conversation, its participants and its messages while it has a
--    participant row, and a participant who left reads up to left_seq and
--    nothing after. There is no Admin exception: an Admin user reads no chat
--    it is not in. mantle_messenger_seq_cap() answers the cap; it is a
--    security definer so the participants policy does not read itself.
--  - Writes go through packages/content/src/messenger.ts on the system pool
--    (ACCESS_MATRIX writer 'system'); the workspace role gets SELECT only.
--  - Two NOTIFY triggers, ids only, never text: messenger_changed (the live
--    stream) and login_notice kind 'message' (the phone, from Phase 5; the
--    handler skips the kind until then).
--  - push_login_prefs gains messages (all, mentions, off) and
--    message_preview. login_presence keeps when a login's stream last beat
--    ("online"); it is not a column of auth.users, whose writer is admin.
--
-- No LLM work, no queue row, no cron: nothing here can start a turn.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "messenger_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "title" text,
  "picture_attachment_id" uuid,
  "workspace_id" uuid REFERENCES "public"."workspaces"("id") ON DELETE SET NULL,
  "agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE SET NULL,
  "direct_key" text,
  "created_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at" timestamp with time zone,
  "last_seq" bigint NOT NULL DEFAULT 0,
  "last_message_at" timestamp with time zone,
  "last_preview" jsonb,
  CONSTRAINT "messenger_conversations_kind_ck" CHECK ("kind" IN ('direct', 'group')),
  CONSTRAINT "messenger_conversations_direct_ck" CHECK (
    ("kind" = 'direct' AND "direct_key" IS NOT NULL AND "workspace_id" IS NULL)
    OR ("kind" = 'group' AND "direct_key" IS NULL)),
  CONSTRAINT "messenger_conversations_agent_ck" CHECK ("agent_id" IS NULL OR "workspace_id" IS NOT NULL),
  CONSTRAINT "messenger_conversations_title_ck" CHECK ("title" IS NULL OR char_length("title") <= 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_conversations_direct_key_uq"
  ON "messenger_conversations" ("direct_key") WHERE "direct_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_conversations_last_message_idx"
  ON "messenger_conversations" ("last_message_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "messenger_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "public"."messenger_conversations"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "login_id" uuid REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE CASCADE,
  -- A group admin (the creator first): adds and removes people, renames,
  -- deletes history for everyone. A direct chat has none.
  "admin" boolean NOT NULL DEFAULT false,
  "joined_at" timestamp with time zone NOT NULL DEFAULT now(),
  "added_by" uuid,
  "left_at" timestamp with time zone,
  "left_seq" bigint,
  "last_read_seq" bigint NOT NULL DEFAULT 0,
  "mention_seq" bigint NOT NULL DEFAULT 0,
  "cleared_before_seq" bigint NOT NULL DEFAULT 0,
  "muted" boolean NOT NULL DEFAULT false,
  CONSTRAINT "messenger_participants_kind_ck" CHECK (
    ("kind" = 'login' AND "login_id" IS NOT NULL AND "agent_id" IS NULL)
    OR ("kind" = 'agent' AND "agent_id" IS NOT NULL AND "login_id" IS NULL)),
  CONSTRAINT "messenger_participants_left_ck" CHECK (("left_at" IS NULL) = ("left_seq" IS NULL))
);
--> statement-breakpoint
-- A primary key cannot name coalesce(login_id, agent_id): one partial unique
-- index per kind instead (plan section 20, item 7).
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_participants_login_uq"
  ON "messenger_participants" ("conversation_id", "login_id") WHERE "kind" = 'login';
--> statement-breakpoint
-- At most one agent per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_participants_agent_uq"
  ON "messenger_participants" ("conversation_id") WHERE "kind" = 'agent';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_participants_login_left_idx"
  ON "messenger_participants" ("login_id", "left_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "messenger_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "public"."messenger_conversations"("id") ON DELETE CASCADE,
  "seq" bigint NOT NULL,
  "author_kind" text NOT NULL,
  "author_login_id" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "author_agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE SET NULL,
  "author_name" text,
  -- How it was sent: via is the label shown (an OAuth client name, a key
  -- label, a peer name); via_ref the credential itself (oauth:<client id>,
  -- key:<key id>, peer:<peer id>). messenger_wait filters on via_ref: two
  -- Claude Code installs share the name "Claude Code" (plan section 20).
  "via" text,
  "via_ref" text,
  "body" text NOT NULL DEFAULT '',
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "mentions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "reply_to_seq" bigint,
  "client_msg_id" text,
  "status" text NOT NULL DEFAULT 'complete',
  "turn_id" uuid,
  "error" text,
  "edited_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "messenger_messages_author_ck" CHECK ("author_kind" IN ('login', 'agent', 'system')),
  CONSTRAINT "messenger_messages_status_ck" CHECK ("status" IN ('complete', 'pending', 'failed')),
  CONSTRAINT "messenger_messages_seq_ck" CHECK ("seq" > 0),
  CONSTRAINT "messenger_messages_body_ck" CHECK (char_length("body") <= 8000),
  CONSTRAINT "messenger_messages_client_msg_ck" CHECK ("client_msg_id" IS NULL OR char_length("client_msg_id") <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_messages_seq_uq"
  ON "messenger_messages" ("conversation_id", "seq");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_messages_client_msg_uq"
  ON "messenger_messages" ("conversation_id", "author_login_id", "client_msg_id")
  WHERE "client_msg_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_messages_created_idx"
  ON "messenger_messages" ("conversation_id", "created_at");
--> statement-breakpoint

-- The bytes come in Phase 4 (POST /api/messenger/attachments answers 501
-- until then); the table lands now so the message's attachment list has a
-- target. An orphan (message_id null after 24 h) is the files worker's to
-- reap, from Phase 4.
CREATE TABLE IF NOT EXISTS "messenger_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "public"."messenger_conversations"("id") ON DELETE CASCADE,
  "message_id" uuid REFERENCES "public"."messenger_messages"("id") ON DELETE CASCADE,
  "uploader_login_id" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "mime" text NOT NULL,
  "bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "path" text NOT NULL,
  "duration_ms" integer,
  "width" integer,
  "height" integer,
  "thumb_path" text,
  "transcript" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "messenger_attachments_kind_ck" CHECK ("kind" IN ('image', 'file', 'voice', 'audio', 'video'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_attachments_message_idx"
  ON "messenger_attachments" ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_attachments_orphan_idx"
  ON "messenger_attachments" ("created_at") WHERE "message_id" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "messenger_reactions" (
  "message_id" uuid NOT NULL REFERENCES "public"."messenger_messages"("id") ON DELETE CASCADE,
  "login_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "emoji" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "messenger_reactions_pk" PRIMARY KEY ("message_id", "login_id", "emoji"),
  CONSTRAINT "messenger_reactions_emoji_ck" CHECK (char_length("emoji") BETWEEN 1 AND 32)
);
--> statement-breakpoint

-- The pins of the one list: a conversation, or an agent thread.
CREATE TABLE IF NOT EXISTS "messenger_favourites" (
  "login_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "ref_id" uuid NOT NULL,
  "rank" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "messenger_favourites_pk" PRIMARY KEY ("login_id", "kind", "ref_id"),
  CONSTRAINT "messenger_favourites_kind_ck" CHECK ("kind" IN ('conversation', 'agent'))
);
--> statement-breakpoint

-- "Online" (plan section 7): the messenger stream's heartbeat writes it, at
-- most once a minute per login. Read on the system pool only.
CREATE TABLE IF NOT EXISTS "login_presence" (
  "login_id" uuid PRIMARY KEY REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "last_active_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Every table this migration alters, in one statement before the first
-- ALTER (the new ones are empty; push_login_prefs is small).
LOCK TABLE "public"."push_login_prefs", "public"."messenger_conversations",
           "public"."messenger_participants", "public"."messenger_messages",
           "public"."messenger_attachments", "public"."messenger_reactions",
           "public"."messenger_favourites", "public"."login_presence"
  IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."push_login_prefs" ADD COLUMN IF NOT EXISTS "messages" text NOT NULL DEFAULT 'all';
--> statement-breakpoint
ALTER TABLE "public"."push_login_prefs" ADD COLUMN IF NOT EXISTS "message_preview" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_login_prefs_messages_ck') THEN
    ALTER TABLE "public"."push_login_prefs"
      ADD CONSTRAINT "push_login_prefs_messages_ck" CHECK ("messages" IN ('all', 'mentions', 'off'));
  END IF;
END $$;
--> statement-breakpoint

-- ── Row security ─────────────────────────────────────────────────────────────
-- The highest seq the acting login may read in a conversation: null when it
-- holds no participant row (it reads nothing there), left_seq once it left,
-- else every seq. Keyed on mantle_login_id() only, with no Admin exception.
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_seq_cap"(c uuid)
  RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE WHEN p."left_at" IS NULL THEN 9223372036854775807 ELSE p."left_seq" END
    FROM "public"."messenger_participants" p
   WHERE p."conversation_id" = c
     AND p."kind" = 'login'
     AND p."login_id" = (SELECT "public"."mantle_login_id"())
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_messenger_seq_cap"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_messenger_seq_cap"(uuid) TO mantle_view_user;
--> statement-breakpoint

ALTER TABLE "public"."messenger_conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "messenger_conversations_user_read" ON "public"."messenger_conversations";
--> statement-breakpoint
CREATE POLICY "messenger_conversations_user_read" ON "public"."messenger_conversations"
  FOR SELECT TO mantle_view_user
  USING ("public"."mantle_messenger_seq_cap"("id") IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "public"."messenger_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "messenger_participants_user_read" ON "public"."messenger_participants";
--> statement-breakpoint
CREATE POLICY "messenger_participants_user_read" ON "public"."messenger_participants"
  FOR SELECT TO mantle_view_user
  USING ("public"."mantle_messenger_seq_cap"("conversation_id") IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "public"."messenger_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "messenger_messages_user_read" ON "public"."messenger_messages";
--> statement-breakpoint
CREATE POLICY "messenger_messages_user_read" ON "public"."messenger_messages"
  FOR SELECT TO mantle_view_user
  USING ("seq" <= "public"."mantle_messenger_seq_cap"("conversation_id"));
--> statement-breakpoint
ALTER TABLE "public"."messenger_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "messenger_attachments_user_read" ON "public"."messenger_attachments";
--> statement-breakpoint
-- A sent attachment through its message; an unsent one by its uploader only.
CREATE POLICY "messenger_attachments_user_read" ON "public"."messenger_attachments"
  FOR SELECT TO mantle_view_user
  USING (CASE WHEN "message_id" IS NULL
              THEN "uploader_login_id" = (SELECT "public"."mantle_login_id"())
                   AND "public"."mantle_messenger_seq_cap"("conversation_id") IS NOT NULL
              ELSE EXISTS (SELECT 1 FROM "public"."messenger_messages" m
                            WHERE m."id" = "messenger_attachments"."message_id") END);
--> statement-breakpoint
ALTER TABLE "public"."messenger_reactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "messenger_reactions_user_read" ON "public"."messenger_reactions";
--> statement-breakpoint
CREATE POLICY "messenger_reactions_user_read" ON "public"."messenger_reactions"
  FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."messenger_messages" m
                  WHERE m."id" = "messenger_reactions"."message_id"));
--> statement-breakpoint
ALTER TABLE "public"."messenger_favourites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "messenger_favourites_user_read" ON "public"."messenger_favourites";
--> statement-breakpoint
CREATE POLICY "messenger_favourites_user_read" ON "public"."messenger_favourites"
  FOR SELECT TO mantle_view_user
  USING ("login_id" = (SELECT "public"."mantle_login_id"()));
--> statement-breakpoint
ALTER TABLE "public"."login_presence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── messenger_changed: the live stream (ids and seq, never text) ─────────────
-- Payload {c, seq, kind, actor}. kind: new, edit, delete (a message);
-- read (a cursor moved); self (my clear or mute: only the actor refetches);
-- participants (someone joined or left, an admin or the title changed);
-- reaction. The typing event is raised by its route and stored nowhere.
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_notify"(c uuid, s bigint, k text, actor uuid)
  RETURNS void LANGUAGE sql AS $$
  SELECT pg_notify('messenger_changed',
    json_build_object('c', c, 'seq', s, 'kind', k, 'actor', actor)::text)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_messenger_notify"(uuid, bigint, text, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_messages_changed"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "public"."mantle_messenger_notify"(new."conversation_id", new."seq", 'new', new."author_login_id");
  ELSIF new."deleted_at" IS NOT NULL AND old."deleted_at" IS NULL THEN
    PERFORM "public"."mantle_messenger_notify"(new."conversation_id", new."seq", 'delete', NULL);
  ELSIF new."body" IS DISTINCT FROM old."body"
     OR new."status" IS DISTINCT FROM old."status"
     OR new."edited_at" IS DISTINCT FROM old."edited_at" THEN
    PERFORM "public"."mantle_messenger_notify"(new."conversation_id", new."seq", 'edit', NULL);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "messenger_messages_changed" ON "public"."messenger_messages";
--> statement-breakpoint
CREATE TRIGGER "messenger_messages_changed" AFTER INSERT OR UPDATE ON "public"."messenger_messages"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_messenger_messages_changed"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_participants_changed"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "public"."mantle_messenger_notify"(old."conversation_id", NULL, 'participants', old."login_id");
  ELSIF TG_OP = 'INSERT'
     OR new."left_at" IS DISTINCT FROM old."left_at"
     OR new."admin" IS DISTINCT FROM old."admin" THEN
    PERFORM "public"."mantle_messenger_notify"(new."conversation_id", NULL, 'participants', new."login_id");
  ELSIF new."last_read_seq" IS DISTINCT FROM old."last_read_seq" THEN
    PERFORM "public"."mantle_messenger_notify"(new."conversation_id", new."last_read_seq", 'read', new."login_id");
  ELSIF new."cleared_before_seq" IS DISTINCT FROM old."cleared_before_seq"
     OR new."muted" IS DISTINCT FROM old."muted" THEN
    PERFORM "public"."mantle_messenger_notify"(new."conversation_id", NULL, 'self', new."login_id");
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "messenger_participants_changed" ON "public"."messenger_participants";
--> statement-breakpoint
CREATE TRIGGER "messenger_participants_changed" AFTER INSERT OR UPDATE OR DELETE ON "public"."messenger_participants"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_messenger_participants_changed"();
--> statement-breakpoint
-- Only what a reader shows changes the room: the title, the picture, the
-- workspace, the agent, archived. A send's last_seq bump is the message's
-- own event.
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_conversations_changed"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF new."title" IS DISTINCT FROM old."title"
     OR new."picture_attachment_id" IS DISTINCT FROM old."picture_attachment_id"
     OR new."workspace_id" IS DISTINCT FROM old."workspace_id"
     OR new."agent_id" IS DISTINCT FROM old."agent_id"
     OR new."archived_at" IS DISTINCT FROM old."archived_at" THEN
    PERFORM "public"."mantle_messenger_notify"(new."id", NULL, 'participants', NULL);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "messenger_conversations_changed" ON "public"."messenger_conversations";
--> statement-breakpoint
CREATE TRIGGER "messenger_conversations_changed" AFTER UPDATE ON "public"."messenger_conversations"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_messenger_conversations_changed"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_reactions_changed"()
  RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  SELECT m."conversation_id" AS c, m."seq" AS s INTO r
    FROM "public"."messenger_messages" m
   WHERE m."id" = coalesce(new."message_id", old."message_id");
  IF FOUND THEN
    PERFORM "public"."mantle_messenger_notify"(r.c, r.s, 'reaction', coalesce(new."login_id", old."login_id"));
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "messenger_reactions_changed" ON "public"."messenger_reactions";
--> statement-breakpoint
CREATE TRIGGER "messenger_reactions_changed" AFTER INSERT OR DELETE ON "public"."messenger_reactions"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_messenger_reactions_changed"();
--> statement-breakpoint

-- ── login_notice kind 'message': the phone (sent from Phase 5) ───────────────
-- One notice per live human participant that is not the author and not
-- muted, for a message a login wrote. Ids only: the notice module turns it
-- into words on the system pool.
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_login_notice"()
  RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p record;
BEGIN
  IF new."author_kind" <> 'login' THEN
    RETURN NULL;
  END IF;
  FOR p IN
    SELECT x."login_id" FROM "public"."messenger_participants" x
     WHERE x."conversation_id" = new."conversation_id"
       AND x."kind" = 'login'
       AND x."left_at" IS NULL
       AND NOT x."muted"
       AND x."login_id" IS DISTINCT FROM new."author_login_id"
  LOOP
    PERFORM pg_notify('login_notice', json_build_object(
      'kind', 'message', 'loginId', p."login_id",
      'c', new."conversation_id", 'seq', new."seq")::text);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_messenger_login_notice"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "messenger_messages_login_notice" ON "public"."messenger_messages";
--> statement-breakpoint
CREATE TRIGGER "messenger_messages_login_notice" AFTER INSERT ON "public"."messenger_messages"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_messenger_login_notice"();
