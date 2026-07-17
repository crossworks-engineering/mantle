-- Team Forum: the shared successor to the per-contact Team Chat forever-thread.
-- Members create titled TOPICS every member can read; posts are multi-author
-- (member | owner | agent). Plan: "Team Forum — shared topic threads replacing
-- the 1:1 assistant chat" (signed off 2026-07-17).
--
-- forum_topics — one row per thread. kind carries the request flags
-- (review|feature|bug file an owner task in Phase 2; question|discussion stay
-- in the forum). visibility 'private' = author + owner only, NEVER ingested
-- into the brain. pinned is the owner-only announcement mechanism. node_id
-- will point at the topic's shadow forum_topic node when brain ingestion
-- lands (Phase 3).
--
-- forum_posts — flat chronological transcript per topic. Deliberately UNLIKE
-- team_messages: contact_id goes SET NULL (author_name is the durable
-- snapshot) because forum content is team knowledge and outlives its author;
-- revocation kills access, not history. agent posts mirror team_messages
-- (agent_id/model/trace_id + the durable 'pending' bubble).
--
-- forum_read_cursors — per-READER unread cursors (members too, not just the
-- owner). reader_id = contact id, or owner_id for the owner's cursor; no FK
-- since the owner is not a node.

CREATE TABLE IF NOT EXISTS "forum_topics" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"               uuid NOT NULL,
  "title"                  text NOT NULL,
  "kind"                   text NOT NULL DEFAULT 'question' CHECK ("kind" IN ('question', 'review', 'feature', 'bug', 'discussion')),
  "visibility"             text NOT NULL DEFAULT 'team' CHECK ("visibility" IN ('team', 'private')),
  "pinned"                 boolean NOT NULL DEFAULT false,
  "status"                 text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'answered', 'closed')),
  "created_by_contact_id"  uuid REFERENCES "nodes"("id") ON DELETE SET NULL,
  "author_name"            text NOT NULL,
  "node_id"                uuid,
  "post_count"             integer NOT NULL DEFAULT 0,
  "last_post_at"           timestamptz NOT NULL DEFAULT now(),
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forum_topics_list_idx" ON "forum_topics" ("owner_id", "pinned" DESC, "last_post_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forum_topics_author_idx" ON "forum_topics" ("owner_id", "created_by_contact_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "forum_posts" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"                uuid NOT NULL,
  "topic_id"                uuid NOT NULL REFERENCES "forum_topics"("id") ON DELETE CASCADE,
  "author_kind"             text NOT NULL CHECK ("author_kind" IN ('member', 'owner', 'agent')),
  "contact_id"              uuid REFERENCES "nodes"("id") ON DELETE SET NULL,
  "author_name"             text NOT NULL,
  "agent_id"                uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "model"                   text,
  "trace_id"                uuid,
  "body"                    text NOT NULL,
  "attachments"             jsonb NOT NULL DEFAULT '[]'::jsonb,
  "kind"                    text CHECK ("kind" IS NULL OR "kind" IN ('review', 'feature', 'bug')),
  "source_request_task_id"  uuid,
  "channel"                 text NOT NULL DEFAULT 'web',
  "status"                  text NOT NULL DEFAULT 'complete' CHECK ("status" IN ('pending', 'complete', 'failed')),
  "error"                   text,
  "created_at"              timestamptz NOT NULL DEFAULT now(),
  "edited_at"               timestamptz
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forum_posts_topic_idx" ON "forum_posts" ("topic_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forum_posts_recent_idx" ON "forum_posts" ("owner_id", "created_at" DESC);--> statement-breakpoint
-- Serial-per-topic agent turns, enforced by the DB: at most ONE in-flight
-- (pending) agent post per topic. A second concurrent turn's pending insert
-- conflicts here and waits its turn (bounded retry in runForumTurn, with a
-- stale-pending sweep so an abandoned turn can never wedge a topic).
CREATE UNIQUE INDEX IF NOT EXISTS "forum_posts_one_pending_agent_idx" ON "forum_posts" ("topic_id") WHERE "author_kind" = 'agent' AND "status" = 'pending';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "forum_read_cursors" (
  "owner_id"      uuid NOT NULL,
  "reader_id"     uuid NOT NULL,
  "topic_id"      uuid NOT NULL,
  "last_read_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "reader_id", "topic_id")
);
