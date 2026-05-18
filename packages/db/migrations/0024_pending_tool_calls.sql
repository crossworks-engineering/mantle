-- Phase 5b: operator-approved tool execution.
--
-- When a tool marked `requires_confirm=true` is requested by the model,
-- the tool-loop persists a row here instead of running the handler. The
-- operator approves or rejects via /pending; approval triggers execution
-- and stores the result back on the row.

CREATE TYPE pending_tool_status AS ENUM ('pending', 'approved', 'rejected', 'expired');

CREATE TABLE pending_tool_calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  /* The agent that proposed the call. Nullable in case the agent row
     gets deleted before the operator acts. */
  agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  /* The tool the agent wants to run. Resolved by slug at execution time
     so renames/edits propagate. */
  tool_slug    text NOT NULL,
  args         jsonb NOT NULL DEFAULT '{}'::jsonb,
  /* The trace the proposing turn lived under, so the /pending UI can
     deep-link back. Nullable on trace cleanup. */
  trace_id     uuid REFERENCES traces(id) ON DELETE SET NULL,
  status       pending_tool_status NOT NULL DEFAULT 'pending',
  /* Populated after approval-triggered execution. */
  result       jsonb,
  error        text,
  decided_at   timestamptz,
  executed_at  timestamptz,
  /* Auto-expiry sweep (not wired yet) — keeps the queue from growing
     forever. Default TTL set by the application layer. */
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pending_tool_calls_owner_status_idx
  ON pending_tool_calls(owner_id, status);

CREATE INDEX pending_tool_calls_owner_created_idx
  ON pending_tool_calls(owner_id, created_at DESC);
