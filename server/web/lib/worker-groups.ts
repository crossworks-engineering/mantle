import { and, asc, eq } from 'drizzle-orm';
import { agentGroups, agents, db, type AgentGroup } from '@mantle/db';

/**
 * Worker groups (panels) — the web-side data + validation layer behind
 * /settings/worker-groups. A worker group is a NAMED SET of worker agents; a
 * `worker_invoke` run step naming a group macro-expands into one attempt per
 * member plus a panel audit (docs/runs.md "Worker groups / panels";
 * agent_groups, migration 0133).
 *
 * The membership rules MIRROR the `worker_group_ensure` MCP tool
 * (packages/mcp-core/src/build-server.ts): members must be enabled
 * role='worker' agent slugs, 1..10 of them, and the group slug is ≤64 chars.
 * Keeping the check here identical means the UI and the agent-facing tool
 * accept exactly the same groups.
 */

export const WORKER_GROUP_SLUG_MAX = 64;
export const WORKER_GROUP_MAX_MEMBERS = 10;

export type WorkerAgentOption = { slug: string; name: string };

/** Enabled role='worker' agents — the only valid group members (mirrors the
 *  worker_group_ensure eligibility query). */
export async function listEnabledWorkerAgents(ownerId: string): Promise<WorkerAgentOption[]> {
  const rows = await db
    .select({ slug: agents.slug, name: agents.name })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.role, 'worker'), eq(agents.enabled, true)))
    .orderBy(asc(agents.name));
  return rows;
}

export async function listWorkerGroups(ownerId: string): Promise<AgentGroup[]> {
  return db
    .select()
    .from(agentGroups)
    .where(eq(agentGroups.ownerId, ownerId))
    .orderBy(asc(agentGroups.name));
}

export async function getWorkerGroup(ownerId: string, id: string): Promise<AgentGroup | null> {
  const [row] = await db
    .select()
    .from(agentGroups)
    .where(and(eq(agentGroups.ownerId, ownerId), eq(agentGroups.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * Validate a proposed member list against the enabled worker agents — the SAME
 * rule the worker_group_ensure MCP tool enforces (1..10, each an enabled
 * worker). Returns a teaching error string, or null when valid.
 */
export function validateWorkerGroupMembers(
  members: string[],
  enabledWorkerSlugs: ReadonlySet<string>,
): string | null {
  if (members.length < 1) return 'A worker group needs at least one member.';
  if (members.length > WORKER_GROUP_MAX_MEMBERS) {
    return `A worker group has at most ${WORKER_GROUP_MAX_MEMBERS} members (got ${members.length}).`;
  }
  if (new Set(members).size !== members.length) return 'Members must be unique.';
  const missing = members.filter((m) => !enabledWorkerSlugs.has(m));
  if (missing.length > 0) {
    const available = [...enabledWorkerSlugs].join(', ') || '(none yet)';
    return `Unknown or disabled worker(s): ${missing.join(', ')}. Members must be enabled role='worker' agents — available: ${available}.`;
  }
  return null;
}

/** Create a worker group SHELL (slug + name, no members yet — the detail form
 *  adds members and the save path enforces the 1..10 rule). Throws on a
 *  duplicate slug (unique index agent_groups_owner_slug_uq). */
export async function createWorkerGroup(
  ownerId: string,
  input: { slug: string; name: string },
): Promise<AgentGroup> {
  const [row] = await db
    .insert(agentGroups)
    .values({ ownerId, slug: input.slug, name: input.name, memberSlugs: [], enabled: true })
    .returning();
  return row!;
}

/** Update a worker group's name / members / enabled. `memberSlugs` (when
 *  present) must already be validated by the caller. */
export async function updateWorkerGroup(
  ownerId: string,
  id: string,
  patch: { name?: string; memberSlugs?: string[]; enabled?: boolean },
): Promise<AgentGroup | null> {
  const [row] = await db
    .update(agentGroups)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(agentGroups.ownerId, ownerId), eq(agentGroups.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteWorkerGroup(ownerId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(agentGroups)
    .where(and(eq(agentGroups.ownerId, ownerId), eq(agentGroups.id, id)))
    .returning({ id: agentGroups.id });
  return rows.length > 0;
}
