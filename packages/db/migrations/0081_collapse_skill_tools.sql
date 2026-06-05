-- Tools & Skills split, Phase 1 (docs/tools-and-skills.md): collapse the skill
-- arm onto direct agent grants — behavior-IDENTICAL.
--
-- The three agent-capability skills (rich_writing, page_editing, table_authoring)
-- used to confer their tools by being attached to an agent (the effectiveToolSlugs
-- union). They become pure teaching. To preserve every agent's effective tool set,
-- we first UNION each agent's attached-skill tools into its own tool_slugs, then
-- empty those skills' tool_slugs.
--
-- Scoped to those three slugs ONLY: heartbeat skills (e.g. profile_interview) also
-- carry tools via a separate mechanism (heartbeats fire with their bound skill's
-- tools) and must NOT be drained here.
--
-- Idempotent. No-op on a fresh install (runs before any agent/skill rows exist;
-- seeding then creates skills tool-less + agents with direct grants). Matches the
-- runtime: only ENABLED attached skills contribute (resolveAgentSkills filters on
-- enabled), so the collapsed set equals the prior effective set exactly.

UPDATE "agents" a SET
  "tool_slugs" = (
    SELECT array_agg(DISTINCT t)
    FROM (
      SELECT unnest(a."tool_slugs") AS t
      UNION
      SELECT unnest(s."tool_slugs")
      FROM "skills" s
      WHERE s."owner_id" = a."owner_id"
        AND s."enabled" = true
        AND s."slug" = ANY(a."skill_slugs")
        AND s."slug" IN ('rich_writing', 'page_editing', 'table_authoring')
    ) z
  ),
  "updated_at" = now()
WHERE EXISTS (
  SELECT 1 FROM "skills" s
  WHERE s."owner_id" = a."owner_id"
    AND s."enabled" = true
    AND s."slug" = ANY(a."skill_slugs")
    AND s."slug" IN ('rich_writing', 'page_editing', 'table_authoring')
    AND s."tool_slugs" <> '{}'::text[]
);
--> statement-breakpoint
UPDATE "skills" SET "tool_slugs" = '{}'::text[], "updated_at" = now()
WHERE "slug" IN ('rich_writing', 'page_editing', 'table_authoring')
  AND "tool_slugs" <> '{}'::text[];
