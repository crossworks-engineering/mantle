-- Per-login assistants: bind an agent to ONE co-admin login.
--
-- Since 0111 every login is a full admin over the anchor account's data, but
-- chat was never split the same way: `assistant_messages` is keyed
-- (owner_id, agent_id) and every login resolved to the SAME default agent, so
-- two people chatting at once interleaved in one thread — and each turn's
-- history block fed the other person's words to the model.
--
-- Everything downstream of the agent is ALREADY per-agent (the conversation
-- store, the `conversation_changed` NOTIFY payload, read cursors, digests, the
-- inbox), so one nullable pointer is the whole mechanism: give a login its own
-- agent row and each of those splits for free.
--
-- This is thread separation, NOT privacy. Content stays keyed to the anchor,
-- every login can still open every agent's thread from the picker, and
-- recall_window replays any of them. The brain remains the trust boundary.
--
-- ON DELETE SET NULL, not cascade — same reasoning as 0127: deleting the login
-- orphans the assistant but must never destroy its archive. The row lives on
-- as an unassigned agent; the operator deletes it from /settings/agents.

ALTER TABLE "public"."agents"
  ADD COLUMN IF NOT EXISTS "assigned_user_id" uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- When the current assignment was made. The web client compares this against
  -- a local watermark to decide whether to override a stale
  -- `mantle_assistant_agent` cookie pointing at the old shared agent — without
  -- it, assigning an assistant changes nothing for a browser that already has
  -- the cookie set (i.e. exactly the users this feature is for).
  ADD COLUMN IF NOT EXISTS "assigned_at" timestamptz;--> statement-breakpoint

-- A login has at most one assistant; an assistant serves at most one login.
CREATE UNIQUE INDEX IF NOT EXISTS "agents_assigned_user_uq"
  ON "public"."agents" ("assigned_user_id") WHERE "assigned_user_id" IS NOT NULL;
