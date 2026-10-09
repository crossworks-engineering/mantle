/**
 * The tools an agent holds, read straight from its granted tool groups: the
 * union of every ENABLED group in `agents.tool_group_slugs` whose level the
 * agent's own level covers (the runtime's resolve-or-omit rule, without the
 * per-turn viewer cap). Used where a tool call runs on an agent's behalf
 * outside its tool loop, the run queue (access matrix T1): a queued item may
 * only call what the planning agent could call inline.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { agents, db, isViewerLevel, levelCovers, toolGroups } from '@mantle/db';

export type AgentGrant = {
  slug: string;
  /** Every tool slug the agent's groups grant. */
  toolSlugs: Set<string>;
};

/** Null when the agent does not exist (deleted, or never did). */
export async function loadAgentGrant(
  ownerId: string,
  by: { id: string } | { slug: string },
): Promise<AgentGrant | null> {
  const [agent] = await db
    .select({ slug: agents.slug, toolGroupSlugs: agents.toolGroupSlugs, audience: agents.audience })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        'id' in by ? eq(agents.id, by.id) : eq(agents.slug, by.slug),
      ),
    )
    .limit(1);
  if (!agent) return null;
  const groupSlugs = agent.toolGroupSlugs ?? [];
  const toolSlugs = new Set<string>();
  if (groupSlugs.length > 0) {
    const agentLevel = isViewerLevel(agent.audience) ? agent.audience : 'admin';
    const rows = await db
      .select({ toolSlugs: toolGroups.toolSlugs, audience: toolGroups.audience })
      .from(toolGroups)
      .where(
        and(
          eq(toolGroups.ownerId, ownerId),
          eq(toolGroups.enabled, true),
          inArray(toolGroups.slug, groupSlugs),
        ),
      );
    for (const r of rows) {
      const groupLevel = isViewerLevel(r.audience) ? r.audience : 'admin';
      if (!levelCovers(agentLevel, groupLevel)) continue;
      for (const t of r.toolSlugs ?? []) toolSlugs.add(t);
    }
  }
  return { slug: agent.slug, toolSlugs };
}
