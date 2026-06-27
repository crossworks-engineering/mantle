/**
 * Server-side CRUD + fan-out helpers for tool groups (capability bundles).
 *
 * A `tool_group` is { slug, name, description, tool_slugs }. Agents grant it via
 * `agents.tool_group_slugs[]`. From Phase 3 the tool-loop expands an agent's
 * granted groups into its effective tool set; until then groups are dormant.
 * See docs/tools-and-skills.md.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { db, toolGroups, agents, type ToolGroup } from '@mantle/db';
import type { ToolGroupDTO } from '@mantle/client-types';

/** The API/wire shape (see @mantle/client-types). Aliased so `toSummary`'s output
 *  is checked against the client contract — drift is a type error. */
export type ToolGroupSummary = ToolGroupDTO;

function toSummary(g: ToolGroup): ToolGroupSummary {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    description: g.description,
    toolSlugs: g.toolSlugs ?? [],
    enabled: g.enabled,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

export async function listToolGroups(ownerId: string): Promise<ToolGroupSummary[]> {
  const rows = await db
    .select()
    .from(toolGroups)
    .where(eq(toolGroups.ownerId, ownerId))
    .orderBy(asc(toolGroups.slug));
  return rows.map(toSummary);
}

/**
 * Fan-out: `{ groupSlug → agentSlug[] }` for every group granted by at least one
 * agent. Used by the Tools manager to show "granted to N agents" and a meaningful
 * delete confirmation. Single owner-scoped query; absence ⇒ zero grants.
 */
export async function listToolGroupBackrefs(
  ownerId: string,
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ slug: agents.slug, groups: agents.toolGroupSlugs })
    .from(agents)
    .where(eq(agents.ownerId, ownerId));
  const out = new Map<string, string[]>();
  for (const r of rows) {
    for (const g of r.groups ?? []) {
      const list = out.get(g) ?? [];
      list.push(r.slug);
      out.set(g, list);
    }
  }
  return out;
}

export async function getToolGroup(
  ownerId: string,
  id: string,
): Promise<ToolGroupSummary | null> {
  const [row] = await db
    .select()
    .from(toolGroups)
    .where(and(eq(toolGroups.id, id), eq(toolGroups.ownerId, ownerId)))
    .limit(1);
  return row ? toSummary(row) : null;
}

export type CreateToolGroupInput = {
  slug: string;
  name: string;
  description?: string;
  toolSlugs?: string[];
  enabled?: boolean;
};

export async function createToolGroup(
  ownerId: string,
  input: CreateToolGroupInput,
): Promise<ToolGroupSummary> {
  const [row] = await db
    .insert(toolGroups)
    .values({
      ownerId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      toolSlugs: input.toolSlugs ?? [],
      enabled: input.enabled ?? true,
    })
    .returning();
  if (!row) throw new Error('failed to insert tool group');
  return toSummary(row);
}

export type UpdateToolGroupInput = Partial<Omit<CreateToolGroupInput, 'slug'>>;

export async function updateToolGroup(
  ownerId: string,
  id: string,
  patch: UpdateToolGroupInput,
): Promise<ToolGroupSummary | null> {
  const next: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.toolSlugs !== undefined) next.toolSlugs = patch.toolSlugs;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  const [row] = await db
    .update(toolGroups)
    .set(next)
    .where(and(eq(toolGroups.id, id), eq(toolGroups.ownerId, ownerId)))
    .returning();
  return row ? toSummary(row) : null;
}

/**
 * Delete a group. Also strips its slug from every agent's `tool_group_slugs`
 * so no dangling grant is left behind (the integrity `dangling-groups` check
 * would otherwise flag it). Returns false if the group didn't exist.
 */
export async function deleteToolGroup(ownerId: string, id: string): Promise<boolean> {
  const existing = await getToolGroup(ownerId, id);
  if (!existing) return false;
  await db.transaction(async (tx) => {
    await tx
      .delete(toolGroups)
      .where(and(eq(toolGroups.id, id), eq(toolGroups.ownerId, ownerId)));
    // Remove the slug from any agent that granted it.
    await tx
      .update(agents)
      .set({
        toolGroupSlugs: sql`array_remove(${agents.toolGroupSlugs}, ${existing.slug})`,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.ownerId, ownerId), sql`${existing.slug} = ANY(${agents.toolGroupSlugs})`));
  });
  return true;
}
