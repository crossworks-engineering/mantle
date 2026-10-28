-- Calls between people (plan page 886126b4 sections 5, 8, 11 and 12; P1 M1):
-- a call is a LiveKit room named after the messenger conversation. The brain
-- keeps one row per call and one per participant stay; the room itself is
-- LiveKit's. Everything here is written by packages/content/src/messenger-
-- calls.ts on the system pool (ACCESS_MATRIX writer 'system'): the call
-- routes, the LiveKit webhook handler and the one-minute reconciler in the
-- events worker.
--
--  - A call row opens when a participant taps Call and closes when the room
--    is gone (webhook room_finished, or the reconciler), when it runs past
--    MANTLE_CALLS_MAX_MINUTES (cap_reached), when a group admin ends it
--    (closed_by_admin) or when the Calls service is switched off
--    (service_off). One open call per conversation (a partial unique index).
--  - started_seq is the seq of the call's own "call started" system line,
--    so row security answers a call row exactly as it answers that line:
--    a live participant reads it, a leaver reads it while the line is
--    under its left_seq, a login added later from its from_seq.
--  - messenger_messages gains `event`: a system line that marks a call
--    carries {type: call_started | call_ended | call_cap, callId, ...}; an
--    ordinary row keeps null. Phase 1 kept no room events in a column, so
--    this is the one (checked 2026-10-28: the system lines of 0335 are
--    body-only).
--  - messenger_conversations gains voice_replies (section 7, P3): stored
--    now so the client's PATCH has a column, read by nothing in P1.
--  - messenger_call_webhooks is the webhook's replay guard: one row per
--    LiveKit event id; a second delivery of the same id is a no-op. The
--    reconciler reaps rows older than a day.
--
-- No LLM work, no queue row, no cron: nothing here can start a call or a
-- voice job. Only a person's tap on the route does (section 12).

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "messenger_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "public"."messenger_conversations"("id") ON DELETE CASCADE,
  "room_name" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'audio',
  "started_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "started_seq" bigint NOT NULL,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at" timestamp with time zone,
  "ended_reason" text,
  "duration_s" integer,
  "max_participants" integer NOT NULL DEFAULT 0,
  "agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE SET NULL,
  "agent_seconds" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "messenger_calls_kind_ck" CHECK ("kind" IN ('audio', 'video')),
  CONSTRAINT "messenger_calls_room_ck" CHECK (char_length("room_name") BETWEEN 1 AND 120),
  CONSTRAINT "messenger_calls_ended_ck" CHECK (("ended_at" IS NULL) = ("ended_reason" IS NULL)),
  CONSTRAINT "messenger_calls_reason_ck" CHECK ("ended_reason" IS NULL OR "ended_reason" IN
    ('finished', 'cap_reached', 'closed_by_admin', 'service_off', 'reconciled')),
  CONSTRAINT "messenger_calls_seq_ck" CHECK ("started_seq" > 0),
  CONSTRAINT "messenger_calls_duration_ck" CHECK ("duration_s" IS NULL OR "duration_s" >= 0),
  CONSTRAINT "messenger_calls_counts_ck" CHECK ("max_participants" >= 0 AND "agent_seconds" >= 0)
);
--> statement-breakpoint
-- One open call per conversation (section 12).
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_calls_open_uq"
  ON "messenger_calls" ("conversation_id") WHERE "ended_at" IS NULL;
--> statement-breakpoint
-- The webhook and the reconciler find the open row by the room's name.
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_calls_room_open_uq"
  ON "messenger_calls" ("room_name") WHERE "ended_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_calls_conversation_idx"
  ON "messenger_calls" ("conversation_id", "started_at");
--> statement-breakpoint

-- One row per stay: a login that leaves and joins again has two rows. The
-- plan's key (call, kind, login or agent, joined_at) cannot be a primary key
-- (coalesce), so an id and one partial unique index per kind, as 0335 did
-- for the participants.
CREATE TABLE IF NOT EXISTS "messenger_call_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_id" uuid NOT NULL REFERENCES "public"."messenger_calls"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "login_id" uuid REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "agent_id" uuid REFERENCES "public"."agents"("id") ON DELETE CASCADE,
  "joined_at" timestamp with time zone NOT NULL DEFAULT now(),
  "left_at" timestamp with time zone,
  -- What the client said it is ("web", "desktop", "phone"), at most 32 chars.
  "device" text,
  CONSTRAINT "messenger_call_participants_kind_ck" CHECK (
    ("kind" = 'login' AND "login_id" IS NOT NULL AND "agent_id" IS NULL)
    OR ("kind" = 'agent' AND "agent_id" IS NOT NULL AND "login_id" IS NULL)),
  CONSTRAINT "messenger_call_participants_device_ck" CHECK ("device" IS NULL OR char_length("device") <= 32)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_call_participants_login_uq"
  ON "messenger_call_participants" ("call_id", "login_id", "joined_at") WHERE "kind" = 'login';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_call_participants_agent_uq"
  ON "messenger_call_participants" ("call_id", "agent_id", "joined_at") WHERE "kind" = 'agent';
--> statement-breakpoint
-- The open stays of a call (the webhook's and the reconciler's lookup).
CREATE INDEX IF NOT EXISTS "messenger_call_participants_open_idx"
  ON "messenger_call_participants" ("call_id") WHERE "left_at" IS NULL;
--> statement-breakpoint

-- The webhook's replay guard (section 11): LiveKit signs every event and
-- names it; a delivery whose id is here already changes nothing.
CREATE TABLE IF NOT EXISTS "messenger_call_webhooks" (
  "event_id" text PRIMARY KEY NOT NULL,
  "event" text NOT NULL,
  "room_name" text,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "messenger_call_webhooks_id_ck" CHECK (char_length("event_id") BETWEEN 1 AND 200),
  CONSTRAINT "messenger_call_webhooks_event_ck" CHECK (char_length("event") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_call_webhooks_received_idx"
  ON "messenger_call_webhooks" ("received_at");
--> statement-breakpoint

-- Every table this migration alters, in one statement before the first
-- ALTER (the three new ones are empty).
LOCK TABLE "public"."messenger_messages", "public"."messenger_conversations",
           "public"."messenger_calls", "public"."messenger_call_participants",
           "public"."messenger_call_webhooks"
  IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."messenger_messages" ADD COLUMN IF NOT EXISTS "event" jsonb;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messenger_messages_event_ck') THEN
    ALTER TABLE "public"."messenger_messages"
      ADD CONSTRAINT "messenger_messages_event_ck" CHECK ("event" IS NULL OR jsonb_typeof("event") = 'object');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "public"."messenger_conversations" ADD COLUMN IF NOT EXISTS "voice_replies" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ── Row security: a call as its own "call started" line ─────────────────────
ALTER TABLE "public"."messenger_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "messenger_calls_user_read" ON "public"."messenger_calls";
--> statement-breakpoint
CREATE POLICY "messenger_calls_user_read" ON "public"."messenger_calls"
  FOR SELECT TO mantle_view_user
  USING ("started_seq" <= "public"."mantle_messenger_seq_cap"("conversation_id")
         AND "started_seq" > "public"."mantle_messenger_seq_floor"("conversation_id"));
--> statement-breakpoint
ALTER TABLE "public"."messenger_call_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "messenger_call_participants_user_read" ON "public"."messenger_call_participants";
--> statement-breakpoint
CREATE POLICY "messenger_call_participants_user_read" ON "public"."messenger_call_participants"
  FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."messenger_calls" k
                  WHERE k."id" = "messenger_call_participants"."call_id"));
--> statement-breakpoint
-- The replay guard is the system's: no policy, so the workspace role reads
-- no row of it.
ALTER TABLE "public"."messenger_call_webhooks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
