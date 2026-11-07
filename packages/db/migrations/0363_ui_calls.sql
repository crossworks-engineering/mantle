-- The agent UI channel's calls (docs/agent-ui.md): one row per ui_* tool
-- call an in-app agent makes on the window its turn named. The tool inserts
-- the row (status 'pending', expires_at 15 seconds on), publishes a ui-call
-- event on the turn's stream and waits; the window answers it once
-- (POST /api/assistant/turn/:turnId/ui/:callId): status 'done' and its
-- result, then NOTIFY ui_result '<id>'. A Stop marks the turn's open calls
-- 'expired'. A pending row past expires_at is never answered: the answer's
-- UPDATE asks expires_at > now().
--
-- step_key is the turn id and the tool call's id: a DBOS re-run of the same
-- tool step finds its row again (unique) instead of asking the window twice.
-- turn_id is the turn's stream id (the client-minted idempotency key), so
-- text. A row goes with its login.
--
-- Read (the row rule below, for the workspace role): a login's own rows
-- only, as mcp_calls (0345). Written through systemDb only (the access
-- matrix: INSERT, and UPDATE of status, result and answered_at on the
-- narrow route). Rows are a few hundred bytes; no sweep.
--
-- Grants come from the access matrix (applyViewerGrants), never from here.
-- Idempotent. Revert: packages/db/rollback/0363_ui_calls.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."ui_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "turn_id" text NOT NULL,
  "login_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "window_id" text NOT NULL,
  "step_key" text NOT NULL,
  "action" text NOT NULL,
  "args" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "answered_at" timestamp with time zone,
  CONSTRAINT "ui_calls_status_check" CHECK ("status" IN ('pending', 'done', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ui_calls_step_key_idx" ON "public"."ui_calls" ("step_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ui_calls_turn_idx" ON "public"."ui_calls" ("turn_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ui_calls_created_idx" ON "public"."ui_calls" ("created_at");
--> statement-breakpoint

LOCK TABLE "public"."ui_calls" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "public"."ui_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "ui_calls_user_read" ON "public"."ui_calls";
--> statement-breakpoint
CREATE POLICY "ui_calls_user_read" ON "public"."ui_calls" FOR SELECT TO mantle_view_user
  USING ("login_id" = (SELECT "public"."mantle_login_id"()));
