/**
 * Server-side CRUD + composition helpers for skills.
 *
 * A `skill` is { slug, name, description, instructions, tool_slugs }.
 * It gets attached to agents via `agents.skill_slugs[]`. When the
 * tool-loop runs, the caller composes the agent's effective system
 * prompt + tool set by unioning every attached skill's bits.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, skills, type Skill } from '@mantle/db';

export type SkillSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  toolSlugs: string[];
  /** Template state shape a heartbeat inherits on create. Empty {}
   *  unless the skill author has filled it in (e.g.
   *  {answered:[], expecting_reply:false} for interview skills). */
  defaultState: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

function toSummary(s: Skill): SkillSummary {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    instructions: s.instructions,
    toolSlugs: s.toolSlugs ?? [],
    defaultState: (s.defaultState ?? {}) as Record<string, unknown>,
    enabled: s.enabled,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function listSkills(ownerId: string): Promise<SkillSummary[]> {
  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.ownerId, ownerId))
    .orderBy(asc(skills.slug));
  return rows.map(toSummary);
}

export async function getSkill(
  ownerId: string,
  id: string,
): Promise<SkillSummary | null> {
  const [row] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.ownerId, ownerId)))
    .limit(1);
  return row ? toSummary(row) : null;
}

export type CreateSkillInput = {
  slug: string;
  name: string;
  description: string;
  instructions?: string;
  toolSlugs?: string[];
  defaultState?: Record<string, unknown>;
  enabled?: boolean;
};

export async function createSkill(
  ownerId: string,
  input: CreateSkillInput,
): Promise<SkillSummary> {
  const [row] = await db
    .insert(skills)
    .values({
      ownerId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      instructions: input.instructions ?? '',
      toolSlugs: input.toolSlugs ?? [],
      defaultState: input.defaultState ?? {},
      enabled: input.enabled ?? true,
    })
    .returning();
  if (!row) throw new Error('failed to insert skill');
  return toSummary(row);
}

export type UpdateSkillInput = Partial<Omit<CreateSkillInput, 'slug'>>;

export async function updateSkill(
  ownerId: string,
  id: string,
  patch: UpdateSkillInput,
): Promise<SkillSummary | null> {
  const next: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.instructions !== undefined) next.instructions = patch.instructions;
  if (patch.toolSlugs !== undefined) next.toolSlugs = patch.toolSlugs;
  if (patch.defaultState !== undefined) next.defaultState = patch.defaultState;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  const [row] = await db
    .update(skills)
    .set(next)
    .where(and(eq(skills.id, id), eq(skills.ownerId, ownerId)))
    .returning();
  return row ? toSummary(row) : null;
}

export async function deleteSkill(ownerId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(skills)
    .where(and(eq(skills.id, id), eq(skills.ownerId, ownerId)))
    .returning({ id: skills.id });
  return rows.length > 0;
}

/**
 * Resolve a batch of skill slugs to enabled rows. Used by the tool-loop
 * callers to compose the agent's effective prompt + tool set.
 */
export async function resolveSkills(
  ownerId: string,
  slugs: string[],
): Promise<SkillSummary[]> {
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
  return rows.map(toSummary);
}

/**
 * Append every enabled skill's instructions to a base system prompt.
 * Each skill block is fenced with a small header so the model can tell
 * them apart from the persona.
 */
export function composeSystemPromptWithSkills(
  basePrompt: string,
  skillRows: SkillSummary[],
): string {
  if (skillRows.length === 0) return basePrompt;
  const blocks = skillRows
    .filter((s) => s.instructions.trim().length > 0)
    .map((s) => `## Skill: ${s.name}\n\n${s.instructions.trim()}`)
    .join('\n\n');
  if (!blocks) return basePrompt;
  return `${basePrompt.trim()}\n\n${blocks}`;
}

/**
 * Compute the union of an agent's own tool_slugs and every attached
 * skill's tool_slugs. Deduped. Skills declare *suggested* tools; the
 * union is the agent's effective allowlist for the tool-loop.
 */
export function effectiveToolSlugs(
  agentToolSlugs: string[],
  skillRows: SkillSummary[],
): string[] {
  const set = new Set<string>(agentToolSlugs);
  for (const s of skillRows) {
    for (const slug of s.toolSlugs) set.add(slug);
  }
  return Array.from(set);
}
