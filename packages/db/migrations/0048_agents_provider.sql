-- Add a `provider` column to `agents` so agents pick up the same
-- provider-honoured chat dispatch the ai_workers table has had since
-- migration 0042. Before this column, agents were implicitly hard-wired
-- to OpenRouter — the responder, web /assistant, heartbeats, and
-- invoke_agent all constructed `new OpenRouter(...)` regardless of
-- what the agent row said.
--
-- Phase 3b (commit 148d423) made the runtime read the column via
-- `(agent as { provider?: string }).provider ?? 'openrouter'`, so this
-- migration backfilling 'openrouter' on every existing row matches the
-- runtime's fallback exactly — no behavioural change for existing
-- installs. After this lands the /settings/agents form (3d) unlocks
-- the provider dropdown for new agents.
--
-- Defaulting to 'openrouter' on the column means a freshly-INSERTed
-- agent row without an explicit provider value gets the same routing
-- it always had. The application layer treats provider as required
-- (the new form will require it), but the DB default keeps backwards
-- compat for any script that inserts directly.

alter table "agents"
  add column if not exists "provider" text not null default 'openrouter';

-- Belt-and-braces: existing rows are already covered by the column
-- default at INSERT time, but rows inserted between the ALTER TABLE
-- and a long-running migration would race. Explicitly set every
-- pre-existing row to 'openrouter' to remove that window.
update "agents" set "provider" = 'openrouter' where "provider" is null;
