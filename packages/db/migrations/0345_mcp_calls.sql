-- The MCP call log (Journal v3 J8, part 1): one row per MCP tools/call, on
-- every transport and for every login kind (an OAuth connector, an API key,
-- a peer, the stdio server). Learning data for a later step that groups a
-- login's calls into work sessions; not the security trail (an API key's
-- write keeps its audit_log row). No model runs on it here.
--
-- Columns: the login and how it connected (via: oauth, key, peer, stdio),
-- the workspace the call named or a create landed in (a snapshot, no
-- foreign key), the work session (session_id), the tool, its arguments
-- (secrets redacted, capped about 4 KB by the writer), ok, the error text
-- (capped about 1 KB), the duration, the item ids the arguments and the
-- top-level reply name (at most 50), the reply's size in bytes. No reply
-- body is kept. A row goes with its login.
--
-- Written once per call by the one MCP gateway (@mantle/mcp-core
-- gated-tools.ts, @mantle/db mcp-call-log.ts), fire and forget, through
-- systemDb as system:audit:mcp-call (the narrow route in a login's scope:
-- INSERT only, access-matrix.ts NARROW_WRITES). Its session id is read in
-- the same statement: the login's last call within 30 minutes gives its
-- session, else a new one (mcp_calls_login_created_idx).
--
-- Read (the row rule below, for the workspace role): a login's own rows
-- only, an Admin user's too (management, not reading: docs/workspaces.md),
-- as assistant_messages and chat_threads (0269). A reader across logins
-- runs on the system pool. No role writes it but the system pool. The
-- nightly mcp-calls-reap sweep removes rows older than 90 days
-- (mcp_calls_created_idx).
--
-- Grants come from the access matrix (applyViewerGrants), never from here.
-- Idempotent. The `when` sits above 0342's (0341 and 0342 are other
-- branches'). Revert: packages/db/rollback/0345_mcp_calls.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."mcp_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "login_id" uuid REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "via" text NOT NULL,
  "workspace_id" uuid,
  "session_id" uuid NOT NULL,
  "tool" text NOT NULL,
  "args" jsonb NOT NULL,
  "ok" boolean NOT NULL,
  "error" text,
  "duration_ms" integer NOT NULL,
  "item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "result_bytes" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_calls_login_created_idx"
  ON "public"."mcp_calls" ("login_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_calls_created_idx" ON "public"."mcp_calls" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_calls_session_idx" ON "public"."mcp_calls" ("session_id");
--> statement-breakpoint

LOCK TABLE "public"."mcp_calls" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."mcp_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_calls_user_read" ON "public"."mcp_calls";
--> statement-breakpoint
CREATE POLICY "mcp_calls_user_read" ON "public"."mcp_calls" FOR SELECT TO mantle_view_user
  USING ("login_id" = (SELECT "public"."mantle_login_id"()));
