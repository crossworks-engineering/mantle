/**
 * A heartbeat runs the prompt of its skill and of its agent (the agent's
 * system prompt, persona notes and skills) in its maker's scope
 * (heartbeats.created_by, W7a fix round 3). So a login other than the brain
 * owner that writes one of those prompts has set up what the heartbeat
 * does: the heartbeats that run it become that login's (W7a fix round 4),
 * and the tick fires them as that login, never as the anchor with the
 * other login's words.
 *
 * The anchor's own saves leave every maker as it is.
 */
import { and, arrayContains, eq, inArray, or, type SQL } from 'drizzle-orm';
import { agents, db, heartbeats } from '@mantle/db';

export type HeartbeatPromptSource = {
  /** A skill saved: the heartbeats that run it, and those of every agent
   *  that carries it among its own skills. */
  skillSlug?: string;
  /** An integration group whose usage skill was saved: the heartbeats of
   *  every agent granted the group (the skill rides with the grant). */
  toolGroupSlug?: string;
  /** An agent's prompt saved: the heartbeats bound to it. */
  agentSlug?: string;
};

/**
 * Make the heartbeats that run `source` login `login`'s. No-op for the
 * anchor (`login` null or the brain owner). Returns how many changed. Runs
 * on the pool its caller is on: a route's, or an area tool's system pool.
 */
export async function restampHeartbeatMakers(
  ownerId: string,
  login: string | null | undefined,
  source: HeartbeatPromptSource,
): Promise<number> {
  if (!login || login === ownerId) return 0;
  const agentSlugs = new Set<string>();
  if (source.agentSlug) agentSlugs.add(source.agentSlug);
  const holders: SQL[] = [];
  if (source.skillSlug) holders.push(arrayContains(agents.skillSlugs, [source.skillSlug]));
  if (source.toolGroupSlug) {
    holders.push(arrayContains(agents.toolGroupSlugs, [source.toolGroupSlug]));
  }
  if (holders.length > 0) {
    const rows = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(and(eq(agents.ownerId, ownerId), or(...holders)));
    for (const r of rows) agentSlugs.add(r.slug);
  }
  const runs: SQL[] = [];
  if (source.skillSlug) runs.push(eq(heartbeats.skillSlug, source.skillSlug));
  if (agentSlugs.size > 0) runs.push(inArray(heartbeats.agentSlug, [...agentSlugs]));
  if (runs.length === 0) return 0;
  const changed = await db
    .update(heartbeats)
    .set({ createdBy: login })
    .where(and(eq(heartbeats.ownerId, ownerId), or(...runs)))
    .returning({ id: heartbeats.id });
  return changed.length;
}
