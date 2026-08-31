import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db, assistantMessages, notSuperseded, traces } from '@mantle/db';
import type { AgentExperienceComponentsDTO, AgentExperienceDTO } from '@mantle/client-types';

/**
 * Agent experience (XP + level) — a read-time rollup of work the agent has
 * actually done in THIS brain. Display only: the level never gates tools,
 * trust, or routing (those stay manual). Nothing is stored; the sources are
 * tables that already record the work:
 *
 *   - turns          assistant_messages outbound rows per agent — covered by
 *                    the (owner_id, agent_id, created_at) index.
 *   - toolSuccesses  the per-turn `toolStats.succeeded` tally each turn
 *                    already persists in assistant_messages.data.
 *   - delegations    child runs completed for other agents (traces with
 *                    kind='manual', subject_kind='child_agent', success).
 *   - heartbeats     heartbeat_fire traces that succeeded.
 *
 * The raw components always ride next to the level so the UI can show WHY an
 * agent is level N — the level must never claim history it cannot show.
 */

/** XP per unit of each component. Tuning these only changes the display. */
export const XP_WEIGHTS = {
  turn: 10,
  toolSuccess: 2,
  delegation: 15,
  heartbeat: 5,
} as const;

/** Soft-cap curve: cumulative XP required to REACH `level`.
 *  Level 1 is free; each next level costs more (power 1.5), so early levels
 *  feel fast and high levels are earned: L2=100, L5=800, L10=2.7k, L52≈36k. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(100 * Math.pow(level - 1, 1.5));
}

/** Inverse of `xpForLevel` — the level a given XP total has reached, plus the
 *  bracket [levelXp, nextLevelXp) the UI needs for a progress ring. */
export function levelFromXp(xp: number): { level: number; levelXp: number; nextLevelXp: number } {
  const safe = Math.max(0, Math.floor(xp));
  // Closed form of the inverse, then settle rounding drift exactly.
  let level = Math.floor(Math.pow(safe / 100, 2 / 3)) + 1;
  while (xpForLevel(level + 1) <= safe) level += 1;
  while (level > 1 && xpForLevel(level) > safe) level -= 1;
  return { level, levelXp: xpForLevel(level), nextLevelXp: xpForLevel(level + 1) };
}

/** Weigh raw counts into the wire DTO. */
export function experienceFromComponents(c: AgentExperienceComponentsDTO): AgentExperienceDTO {
  const xp =
    c.turns * XP_WEIGHTS.turn +
    c.toolSuccesses * XP_WEIGHTS.toolSuccess +
    c.delegations * XP_WEIGHTS.delegation +
    c.heartbeats * XP_WEIGHTS.heartbeat;
  return { xp, ...levelFromXp(xp), components: c };
}

/** The honest zero — a brand-new agent is level 1 with nothing to show. */
export function zeroExperience(): AgentExperienceDTO {
  return experienceFromComponents({ turns: 0, toolSuccesses: 0, delegations: 0, heartbeats: 0 });
}

/**
 * Experience for the owner's agents, keyed by agent id. Two grouped queries
 * regardless of agent count. Agents with no recorded work are absent — callers
 * default them with `zeroExperience()`. Pass `agentIds` to scope the scan when
 * only one agent matters (the assistant thread bundle).
 */
export async function computeAgentExperience(
  ownerId: string,
  agentIds?: string[],
): Promise<Map<string, AgentExperienceDTO>> {
  if (agentIds && agentIds.length === 0) return new Map();
  const scope = agentIds ? inArray(assistantMessages.agentId, agentIds) : undefined;
  const traceScope = agentIds ? inArray(traces.agentId, agentIds) : undefined;

  const [turnRows, traceRows] = await Promise.all([
    db
      .select({
        agentId: assistantMessages.agentId,
        turns: sql<number>`count(*)::int`,
        toolSuccesses: sql<number>`coalesce(sum(coalesce((${assistantMessages.data}->'toolStats'->>'succeeded')::int, 0)), 0)::int`,
      })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.ownerId, ownerId),
          eq(assistantMessages.direction, 'outbound'),
          isNotNull(assistantMessages.agentId),
          notSuperseded(),
          scope,
        ),
      )
      .groupBy(assistantMessages.agentId),
    db
      .select({
        agentId: traces.agentId,
        delegations: sql<number>`count(*) filter (where ${traces.kind} = 'manual' and ${traces.subjectKind} = 'child_agent')::int`,
        heartbeats: sql<number>`count(*) filter (where ${traces.kind} = 'heartbeat_fire')::int`,
      })
      .from(traces)
      .where(
        and(
          eq(traces.ownerId, ownerId),
          eq(traces.status, 'success'),
          isNotNull(traces.agentId),
          or(
            eq(traces.kind, 'heartbeat_fire'),
            and(eq(traces.kind, 'manual'), eq(traces.subjectKind, 'child_agent')),
          ),
          traceScope,
        ),
      )
      .groupBy(traces.agentId),
  ]);

  const components = new Map<string, AgentExperienceComponentsDTO>();
  const bucket = (id: string): AgentExperienceComponentsDTO => {
    let c = components.get(id);
    if (!c) {
      c = { turns: 0, toolSuccesses: 0, delegations: 0, heartbeats: 0 };
      components.set(id, c);
    }
    return c;
  };
  for (const r of turnRows) {
    if (!r.agentId) continue;
    const c = bucket(r.agentId);
    c.turns = r.turns;
    c.toolSuccesses = r.toolSuccesses;
  }
  for (const r of traceRows) {
    if (!r.agentId) continue;
    const c = bucket(r.agentId);
    c.delegations = r.delegations;
    c.heartbeats = r.heartbeats;
  }

  const out = new Map<string, AgentExperienceDTO>();
  for (const [id, c] of components) out.set(id, experienceFromComponents(c));
  return out;
}

/** One agent's experience (never null — an unworked agent is `zeroExperience`). */
export async function getAgentExperience(
  ownerId: string,
  agentId: string,
): Promise<AgentExperienceDTO> {
  const map = await computeAgentExperience(ownerId, [agentId]);
  return map.get(agentId) ?? zeroExperience();
}
