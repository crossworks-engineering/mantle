/**
 * Server-side CRUD + composition helpers for skills.
 *
 * A `skill` is { slug, name, description, instructions } — pure teaching.
 * It attaches to agents via `agents.skill_slugs[]`; its instructions are
 * composed into the agent's system prompt. Skills carry no tools (Phase 4,
 * docs/tools-and-skills.md) — capability lives on tool groups + direct grants.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, heartbeats, skills, type Skill } from '@mantle/db';

export type SkillSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
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

/**
 * Returns a `{slug → heartbeat[]}` map for every skill referenced by
 * at least one heartbeat owned by `ownerId`. Used by /settings/skills
 * to show a badge ("used by N heartbeats") + a meaningful delete
 * confirmation. Skills with zero references aren't in the result —
 * caller treats absence as zero.
 *
 * Single query, owner-scoped at both sides of the implicit join so
 * a malicious slug can't reveal another user's heartbeats.
 */
export async function listSkillBackrefs(
  ownerId: string,
): Promise<Map<string, Array<{ slug: string; name: string; status: string }>>> {
  const rows = await db
    .select({
      skillSlug: heartbeats.skillSlug,
      heartbeatSlug: heartbeats.slug,
      heartbeatName: heartbeats.name,
      status: heartbeats.status,
    })
    .from(heartbeats)
    .where(eq(heartbeats.ownerId, ownerId))
    .orderBy(asc(heartbeats.slug));
  const out = new Map<string, Array<{ slug: string; name: string; status: string }>>();
  for (const r of rows) {
    const list = out.get(r.skillSlug) ?? [];
    list.push({ slug: r.heartbeatSlug, name: r.heartbeatName, status: r.status });
    out.set(r.skillSlug, list);
  }
  return out;
}

// Silence unused-import — sql isn't used directly here but is kept
// for future skill queries that need raw expressions (e.g. case-
// insensitive name search).
void sql;

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
