/**
 * The tools an agent holds, read straight from its granted tool groups: the
 * union of every ENABLED group in `agents.tool_group_slugs`. Used where a
 * tool call runs on an agent's behalf outside its tool loop, the run queue
 * (access matrix T1): a queued item may only call what the planning agent
 * could call inline. Agents and tool groups have no level since workspaces
 * W7b: what an agent may do in a turn is its workspace's scope and the
 * adminOnly groups (skills.ts).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { agents, db, toolGroups } from '@mantle/db';

export type AgentGrant = {
  slug: string;
  /** The agent answers in the Admin workspace, or in none (a specialist or
   *  a worker, which runs in its caller's scope): the run queue's items run
   *  on the system pool, so only such an agent may plan them. */
  admin: boolean;
  /** Every tool slug the agent's groups grant. */
  toolSlugs: Set<string>;
};

/** The agent context a run item carries when no agent planned the run (the
 *  owner's own MCP client did) or its agent is gone. Not a valid agent slug
 *  (agent slugs are [a-z0-9_-]), so no lookup by slug ever finds a real
 *  agent: the Pending row names no requester, persona tools refuse. */
export const NO_AGENT_RUN_SLUG = '(run)';

/** Null when the agent does not exist (deleted, or never did). */
export async function loadAgentGrant(
  ownerId: string,
  by: { id: string } | { slug: string },
): Promise<AgentGrant | null> {
  const [agent] = await db
    .select({
      slug: agents.slug,
      toolGroupSlugs: agents.toolGroupSlugs,
      admin: sql<boolean>`(${agents.workspaceId} is null or exists (
        select 1 from "public"."workspaces" w
         where w.id = ${agents.workspaceId} and w.is_admin))`,
    })
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
    const rows = await db
      .select({ toolSlugs: toolGroups.toolSlugs })
      .from(toolGroups)
      .where(
        and(
          eq(toolGroups.ownerId, ownerId),
          eq(toolGroups.enabled, true),
          inArray(toolGroups.slug, groupSlugs),
        ),
      );
    for (const r of rows) for (const t of r.toolSlugs ?? []) toolSlugs.add(t);
  }
  return { slug: agent.slug, admin: agent.admin === true, toolSlugs };
}
