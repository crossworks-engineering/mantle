-- Per-agent assistant threads — strict isolation.
--
-- Pre-this-migration, assistant_messages had a nullable agent_id (added late
-- via 0023_agents_for_workers; rows authored before that landed had NULL).
-- The runtime worked around it by folding NULL rows into any agent whose
-- role was 'assistant' or 'responder' (recentAssistantMessages.includeLegacy),
-- which meant N assistant-role agents all saw the same legacy turns — the UX
-- bug Jason reported as "different agents show the same chat with content
-- swapped." Path A: backfill the orphans to the user's primary responder /
-- assistant, then make agent_id NOT NULL so the bug class is structurally
-- extinct.
--
-- Single-user system, so each owner_id has one primary persona — pick by
-- (role IN ('responder','assistant'), enabled=true, priority DESC, oldest).
-- If the matching subquery returns no row for an owner, the UPDATE leaves
-- those rows NULL and the DO $$ block below raises with a clear hint.

UPDATE assistant_messages am
SET agent_id = (
  SELECT a.id
  FROM agents a
  WHERE a.owner_id = am.owner_id
    AND a.role IN ('responder', 'assistant')
    AND a.enabled = true
  ORDER BY a.priority DESC NULLS LAST, a.created_at ASC
  LIMIT 1
)
WHERE am.agent_id IS NULL;

DO $$
DECLARE
  remaining int;
BEGIN
  SELECT COUNT(*) INTO remaining FROM assistant_messages WHERE agent_id IS NULL;
  IF remaining > 0 THEN
    RAISE EXCEPTION
      'assistant_messages backfill: % rows still have agent_id IS NULL — no enabled responder/assistant agent for their owner. Create one at /settings/agents and re-run.',
      remaining;
  END IF;
END $$;

ALTER TABLE assistant_messages ALTER COLUMN agent_id SET NOT NULL;

-- Composite index for the per-agent query — recentAssistantMessages now
-- filters strictly by (owner_id, agent_id) ORDER BY created_at DESC, so the
-- single-column owner index isn't optimal once threads multiply.
CREATE INDEX IF NOT EXISTS assistant_messages_owner_agent_created_idx
  ON assistant_messages (owner_id, agent_id, created_at DESC);
