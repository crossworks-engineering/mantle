-- Messenger V1 Phase 1, fix round 2 (plan page d8954876 section 21). 0335
-- stays as dev applied it; what changes is here.
--
--  - A leaver reads the room as it was when it left (H2), and nobody reads
--    another login's private cursors. The workspace role no longer reads
--    the conversation's tail (last_seq, last_message_at, last_preview) nor
--    a participant's left_seq, last_read_seq, mention_seq,
--    cleared_before_seq, from_seq and muted (ACCESS_MATRIX names the
--    columns it reads). Its own participant rows, with the tail capped at
--    its left_seq and no newer time or line, come from
--    mantle_messenger_mine(). The participants policy shows a leaver only
--    the people who joined before it left, and a login added later only the
--    people still there when it joined (the rule participantsOf already
--    applied in its own SQL).
--  - The participants trigger tests a clear or a mute before the read
--    cursor (M2): a clear also moves my cursor, and was told to everyone as
--    a read instead of to me as a self event. Now both are raised.
--  - The unused index on messenger_conversations.last_message_at goes
--    (nothing orders on it, and it kept every send off a HOT update of the
--    busiest row); messenger_participants gets a plain index on
--    conversation_id (the participant lists and the mention check filter
--    without kind, so the partial indexes do not serve them).
--
-- No LLM work, no queue row, no cron: nothing here can start a turn.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- Every table this migration alters, in one statement before the first
-- change.
LOCK TABLE "public"."messenger_conversations", "public"."messenger_participants"
  IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- ── My participant rows, with the tail I may see ───────────────────────────
-- The acting login's own rows (of one conversation, or all with c null):
-- its cursors and, for a live one, the conversation's tail; a leaver's
-- tail is its left_seq with no time and no line. Nobody else's row.
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_mine"(c uuid)
  RETURNS TABLE (
    "conversation_id" uuid, "login_id" uuid, "admin" boolean, "joined_at" timestamp with time zone,
    "left_at" timestamp with time zone, "left_seq" bigint, "last_read_seq" bigint,
    "mention_seq" bigint, "cleared_before_seq" bigint, "from_seq" bigint, "muted" boolean,
    "last_seq" bigint, "last_message_at" timestamp with time zone, "last_preview" jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT p."conversation_id", p."login_id", p."admin", p."joined_at", p."left_at", p."left_seq",
         p."last_read_seq", p."mention_seq", p."cleared_before_seq", p."from_seq", p."muted",
         CASE WHEN p."left_at" IS NULL THEN k."last_seq" ELSE least(k."last_seq", p."left_seq") END,
         CASE WHEN p."left_at" IS NULL THEN k."last_message_at" END,
         CASE WHEN p."left_at" IS NULL THEN k."last_preview" END
    FROM "public"."messenger_participants" p
    JOIN "public"."messenger_conversations" k ON k."id" = p."conversation_id"
   WHERE p."kind" = 'login'
     AND p."login_id" = (SELECT "public"."mantle_login_id"())
     AND (c IS NULL OR p."conversation_id" = c)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_messenger_mine"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_messenger_mine"(uuid) TO mantle_view_user;
--> statement-breakpoint

-- Whether the acting login may see one participant row of a conversation
-- it is in: a leaver only those who joined before it left, a login added
-- later only those still there when it joined. Its own row always.
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_sees_participant"(
  c uuid, joined timestamp with time zone, left_at timestamp with time zone)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT coalesce((
    SELECT (me."left_at" IS NULL OR joined <= me."left_at")
       AND (left_at IS NULL OR left_at >= me."joined_at")
      FROM "public"."messenger_participants" me
     WHERE me."conversation_id" = c
       AND me."kind" = 'login'
       AND me."login_id" = (SELECT "public"."mantle_login_id"())), false)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_messenger_sees_participant"(uuid, timestamp with time zone, timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_messenger_sees_participant"(uuid, timestamp with time zone, timestamp with time zone) TO mantle_view_user;
--> statement-breakpoint
DROP POLICY IF EXISTS "messenger_participants_user_read" ON "public"."messenger_participants";
--> statement-breakpoint
CREATE POLICY "messenger_participants_user_read" ON "public"."messenger_participants"
  FOR SELECT TO mantle_view_user
  USING ("public"."mantle_messenger_sees_participant"("conversation_id", "joined_at", "left_at"));
--> statement-breakpoint

-- ── The participants trigger: a clear or a mute first, then the cursor ──────
CREATE OR REPLACE FUNCTION "public"."mantle_messenger_participants_changed"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('messenger_changed', json_build_object('c', old."conversation_id", 'seq', NULL, 'kind', 'participants', 'actor', old."login_id")::text);
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT'
     OR new."left_at" IS DISTINCT FROM old."left_at"
     OR new."admin" IS DISTINCT FROM old."admin" THEN
    PERFORM pg_notify('messenger_changed', json_build_object('c', new."conversation_id", 'seq', NULL, 'kind', 'participants', 'actor', new."login_id")::text);
    RETURN NULL;
  END IF;
  -- A clear or a mute: only the actor's other tabs refetch.
  IF new."cleared_before_seq" IS DISTINCT FROM old."cleared_before_seq"
     OR new."muted" IS DISTINCT FROM old."muted" THEN
    PERFORM pg_notify('messenger_changed', json_build_object('c', new."conversation_id", 'seq', NULL, 'kind', 'self', 'actor', new."login_id")::text);
  END IF;
  -- The read cursor too (a clear moves it): the read receipt.
  IF new."last_read_seq" IS DISTINCT FROM old."last_read_seq" THEN
    PERFORM pg_notify('messenger_changed', json_build_object('c', new."conversation_id", 'seq', new."last_read_seq", 'kind', 'read', 'actor', new."login_id")::text);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- ── Indexes ──────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "public"."messenger_conversations_last_message_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_participants_conversation_idx"
  ON "messenger_participants" ("conversation_id");
