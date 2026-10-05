-- Chat archive threads (2026-10-05, docs/conversation.md §6c).
--
-- "New chat" archives an agent's chat into its own thread and starts a fresh
-- one. A thread is a TIME RANGE over that agent's assistant_messages:
-- [started_at, archived_at), the open thread has no end. Messages never move
-- and never get a thread column, so no existing row is rewritten. An agent
-- with no row here keeps its forever-thread (no lower bound).
--
--   status          'open' (at most one per agent chat) or 'archived'.
--   summary_node_id the one note the archive action writes (title, summary,
--                   embedding). Written once, inside the archive request; no
--                   trigger and no timer ever starts model work here.
--   seed_thread_id  "Continue from this": the open thread starts with that
--                   archived thread's summary in its context.
--
-- Admin pool only (access matrix: none), like assistant_messages.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."chat_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "public"."agents"("id") ON DELETE CASCADE,
  "status" text NOT NULL CHECK ("status" IN ('open', 'archived')),
  "title" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz,
  "turn_count" integer NOT NULL DEFAULT 0,
  "summary_node_id" uuid REFERENCES "public"."nodes"("id") ON DELETE SET NULL,
  "seed_thread_id" uuid REFERENCES "public"."chat_threads"("id") ON DELETE SET NULL,
  "archived_by" uuid,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_threads_range_ck" CHECK (
    ("status" = 'open' AND "archived_at" IS NULL)
    OR ("status" = 'archived' AND "archived_at" IS NOT NULL AND "archived_at" >= "started_at")
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_threads_owner_agent_started_idx"
  ON "public"."chat_threads" ("owner_id", "agent_id", "started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_threads_one_open_uq"
  ON "public"."chat_threads" ("owner_id", "agent_id")
  WHERE "status" = 'open';
