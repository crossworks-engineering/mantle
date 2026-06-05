/**
 * Skill-composition helpers usable from any process (the agent runner,
 * the Next request handler, future cron workers). Pure logic — no DB
 * imports beyond what's already wired into the runtime. The CRUD lib
 * stays in apps/web for now.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, skills, toolGroups, type Skill } from '@mantle/db';

export type SkillForRuntime = {
  id: string;
  slug: string;
  name: string;
  instructions: string;
};

function toRuntime(s: Skill): SkillForRuntime {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    instructions: s.instructions,
  };
}

/** Resolve a batch of skill slugs to enabled rows for an owner. */
export async function resolveAgentSkills(
  ownerId: string,
  slugs: string[],
): Promise<SkillForRuntime[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.ownerId, ownerId),
        eq(skills.enabled, true),
        inArray(skills.slug, slugs),
      ),
    );
  return rows.map(toRuntime);
}

/**
 * Resolve granted tool-group slugs → the flat, deduped union of their member
 * tool slugs (ENABLED groups only, matching the runtime's resolve-or-omit rule).
 * Empty in ⇒ empty out (no DB hit). See docs/tools-and-skills.md (Phase 3).
 */
export async function resolveAgentToolGroups(
  ownerId: string,
  slugs: string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ toolSlugs: toolGroups.toolSlugs })
    .from(toolGroups)
    .where(
      and(
        eq(toolGroups.ownerId, ownerId),
        eq(toolGroups.enabled, true),
        inArray(toolGroups.slug, slugs),
      ),
    );
  const set = new Set<string>();
  for (const r of rows) for (const t of r.toolSlugs ?? []) set.add(t);
  return Array.from(set);
}

/**
 * Append every skill's instructions to a base system prompt as
 * `## Skill: <name>` blocks. Keeps each skill's voice fenced so the
 * model can tell which guidance belongs to which skill.
 */
export function composeSystemPromptWithSkills(
  basePrompt: string,
  skillsList: SkillForRuntime[],
): string {
  if (skillsList.length === 0) return basePrompt;
  const blocks = skillsList
    .filter((s) => s.instructions.trim().length > 0)
    .map((s) => `## Skill: ${s.name}\n\n${s.instructions.trim()}`)
    .join('\n\n');
  if (!blocks) return basePrompt;
  return `${basePrompt.trim()}\n\n${blocks}`;
}

/** Upper bound on the effective tool-slug union sent to a model. Agent slugs
 *  and each skill's slugs are individually capped at 256; many attached skills
 *  could still union into a huge `tools` array that bloats the prompt or trips
 *  a provider limit. Generous enough that no legitimate config hits it. */
const MAX_EFFECTIVE_TOOL_SLUGS = 512;

/**
 * An agent's effective tool allowlist: its own direct `tool_slugs` unioned with
 * the tools conferred by its granted tool groups (pre-resolved via
 * resolveAgentToolGroups). Skills contribute NOTHING — they're pure teaching as
 * of Phase 4 (the skills.tool_slugs column is gone). Deduped + capped.
 */
export function effectiveToolSlugs(
  agentToolSlugs: string[],
  groupToolSlugs: string[] = [],
): string[] {
  const set = new Set<string>(agentToolSlugs);
  for (const slug of groupToolSlugs) set.add(slug);
  const all = Array.from(set);
  if (all.length > MAX_EFFECTIVE_TOOL_SLUGS) {
    const dropped = all.slice(MAX_EFFECTIVE_TOOL_SLUGS);
    // Not silent — log exactly which slugs were cut so a misconfiguration is
    // diagnosable rather than presenting as "some tools just don't work".
    console.warn(
      `[skills] effective tool-slug union (${all.length}) exceeds cap ${MAX_EFFECTIVE_TOOL_SLUGS}; dropping ${dropped.length}: ${dropped.join(', ')}`,
    );
    return all.slice(0, MAX_EFFECTIVE_TOOL_SLUGS);
  }
  return all;
}
