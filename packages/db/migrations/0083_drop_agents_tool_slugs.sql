-- Tools & Skills split, Phase 6b (docs/tools-and-skills.md): retire the
-- agents.tool_slugs column. Tool GROUPS are now the sole tool-grant mechanism —
-- an agent's effective tool set is exactly the union of its granted groups'
-- tools (resolveAgentToolGroups + effectiveToolSlugs). Every manifest agent is
-- authored as a group list; onboarding seeds the persona from the manifest's
-- group grant; the boot self-heal grants core FLOOR groups; and the dev brain
-- was re-granted onto groups in P6a before this drop. All schema/runtime/editor
-- reads of the column are removed in the same change.

ALTER TABLE "agents" DROP COLUMN IF EXISTS "tool_slugs";
