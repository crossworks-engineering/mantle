-- Phase 0 of the unified per-agent conversation stream (docs/conversation.md).
--
-- ADDITIVE ONLY. This migration extends assistant_messages so every channel
-- (web today; Telegram + future WhatsApp in later phases) can write into one
-- per-(owner, agent) conversation store. It deliberately does NOT touch the
-- summarize triggers: swapping them is the one breaking step, and it must land
-- together with the unified summarizer + the Telegram write path (the cutover
-- migration), not before — otherwise summarization breaks in the gap.
--
-- All three columns have defaults / are nullable, so existing rows (all 'web')
-- and existing INSERTs (which don't mention the new columns) keep working with
-- no backfill.

ALTER TABLE public.assistant_messages
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS external_ref jsonb;

-- Per-agent, per-channel slice for the unified-stream reads.
CREATE INDEX IF NOT EXISTS assistant_messages_owner_agent_channel_created_idx
  ON public.assistant_messages (owner_id, agent_id, channel, created_at);
