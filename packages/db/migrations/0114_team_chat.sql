-- Team Chat: external team members (contacts holding a team token) converse
-- with the brain through a permission-limited responder at /team.
--
-- team_messages — one forever-thread PER CONTACT (mirror of assistant_messages,
-- which is per (owner, agent)). contact_id CASCADEs: deleting a contact is how
-- revocation works (multi-admin precedent), and the conversation goes with the
-- person. The AUDIT of what happened survives in team_access_log (SET NULL) and
-- in traces — trace_id on each outbound row deep-links the full tool-call
-- record for the admin.
--
-- team_access_log — auth / turn / api / denied events per contact, the
-- app_access_log pattern minus the app FK (this surface is brain-level, not
-- share-scoped).

CREATE TABLE IF NOT EXISTS "team_messages" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"    uuid NOT NULL,
  "contact_id"  uuid NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "direction"   text NOT NULL CHECK ("direction" IN ('inbound', 'outbound')),
  "text"        text NOT NULL,
  "agent_id"    uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "model"       text,
  "channel"     text NOT NULL DEFAULT 'web',
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "trace_id"    uuid,
  "status"      text NOT NULL DEFAULT 'complete',
  "error"       text,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_messages_thread_idx" ON "team_messages" ("owner_id", "contact_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_messages_recent_idx" ON "team_messages" ("owner_id", "created_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "team_access_log" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"    uuid NOT NULL,
  "contact_id"  uuid REFERENCES "nodes"("id") ON DELETE SET NULL,
  "kind"        text NOT NULL CHECK ("kind" IN ('auth', 'turn', 'api', 'denied')),
  "detail"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_access_log_recent_idx" ON "team_access_log" ("owner_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_access_log_contact_idx" ON "team_access_log" ("owner_id", "contact_id", "created_at" DESC);
