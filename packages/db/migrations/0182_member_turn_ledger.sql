-- Member chat cost limits (audit F09) and a used_private backfill (audit F23).
--
-- 1. member_turn_ledger: one row per member chat turn, written when the turn
--    is queued (POST /api/member/chat), not when the workflow later writes the
--    inbound message. The daily cap counts these, so turns waiting on a busy
--    queue count. turn_id is the workflow id (login plus Idempotency-Key):
--    a retry with the same key is the same turn and never counts twice. A new
--    table only: cheap on a live database. See packages/content/src/member-turn-ledger.ts.
CREATE TABLE IF NOT EXISTS "member_turn_ledger" (
	"turn_id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"login_id" uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_turn_ledger_login_idx"
  ON "member_turn_ledger" ("login_id", "created_at");
--> statement-breakpoint
-- 2. used_private (0170) was never backfilled. Mark a member-login reply the
--    way run-team-turn.ts (replyUsedPrivate) marks a new one: its turn read the
--    member's private items with a my-space tool (a `tool: my_*` step in its
--    trace), or the history its turn loaded held a marked reply. That history
--    is the N rows of the login's thread before the turn's inbound message (N
--    = the agent's memory_config.history_limit, default 20), hence the window
--    of N + 1 rows before the reply. The mark carries forward reply to reply,
--    as it does live. Idempotent; touches only rows still unmarked; the table
--    is small (member chat threads).
WITH RECURSIVE thread AS (
  SELECT tm.id, tm.login_id, tm.direction, tm.used_private,
         row_number() OVER (PARTITION BY tm.login_id ORDER BY tm.created_at, tm.id) AS rn,
         coalesce((a.memory_config->>'history_limit')::int, 20) AS hl,
         EXISTS (
           SELECT 1 FROM trace_steps s
            WHERE tm.trace_id IS NOT NULL AND s.trace_id = tm.trace_id
              AND s.name IN ('tool: my_items_list', 'tool: my_item_open')
         ) AS read_private
    FROM team_messages tm
    LEFT JOIN agents a ON a.id = tm.agent_id
   WHERE tm.login_id IS NOT NULL
),
marked AS (
  SELECT id, login_id, rn FROM thread
   WHERE direction = 'outbound' AND (read_private OR used_private)
  UNION
  SELECT t.id, t.login_id, t.rn
    FROM thread t
    JOIN marked m ON m.login_id = t.login_id
   WHERE t.direction = 'outbound' AND t.rn > m.rn AND t.rn <= m.rn + t.hl + 1
)
UPDATE team_messages tm
   SET used_private = true
  FROM marked
 WHERE tm.id = marked.id AND tm.used_private = false;
