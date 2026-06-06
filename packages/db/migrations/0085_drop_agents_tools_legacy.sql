-- Cleanup: drop the legacy free-form `agents.tools` jsonb column.
--
-- This is the pre-P6 MCP tool-name array — unrelated to the tools/groups split
-- and dead since capability moved to `tool_group_slugs`. It was still round-
-- tripped through the agents CRUD lib + API (never read for behaviour); those
-- reads are removed in the same change. Safe on every shape: nothing resolves
-- tools from it. `IF EXISTS` keeps it idempotent.

ALTER TABLE "agents" DROP COLUMN IF EXISTS "tools";
