/**
 * Two writes of an Admin area's narrow exit that ran at a full-route spot
 * before (viewer.ts FULL_ROUTE_SPOTS
 * promotion-space and agent-conversation), each now one call of its
 * definer (migration 0317) on the narrow route: the narrow role holds no
 * right on the content tables they write, the definer holds the rule (a
 * system session, the acting login holding the area). Anywhere else (a
 * login's scope, the workspace screen's carried scope, the switch off) the
 * caller's own statements run as before, so every answer there is
 * unchanged; on the narrow route the definer does what they did
 * (narrow-spots.db.test.ts holds the two equal).
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '../schema/index';
import { actingLoginNow } from '../viewer';
import { atActingLogin } from './acting-login';
import { narrowRouteNow } from './pools';
import { withSystemTx } from './system-tx';

type Tx = Pick<PostgresJsDatabase<typeof schema>, 'execute'>;

/**
 * A login made admin, on the narrow route: its personal space's shared and
 * submitted items back to private drafts, in the role change's own
 * transaction `tx` (mantle_space_settle_promotion). How many items, or
 * null off the narrow route (the caller's statements run).
 */
export async function settlePromotionOnNarrow(tx: Tx, target: string): Promise<number | null> {
  if (!narrowRouteNow()) return null;
  const rows = (await tx.execute(
    sql`select mantle_space_settle_promotion(${actingLoginNow()}::uuid, ${target}::uuid) as n`,
  )) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

/** What an assistant's delete removed (agents.ts DeleteAgentResult's
 *  counts), or null when there was no such assistant. */
export type AgentDeleteCounts = { messages: number; digests: number } | null;

/**
 * An assistant deleted on the narrow route, with its conversation or not,
 * in one system transaction (mantle_agent_delete: the digests' heads, the
 * agent row, its messages and digests, a pinned Telegram chat denied).
 * Undefined off the narrow route (the caller's statements run). Wrap in
 * withDeadlockRetry, as the heads helpers.
 */
export async function deleteAgentOnNarrow(
  ownerId: string,
  agentId: string,
  conversation: boolean,
): Promise<AgentDeleteCounts | undefined> {
  if (!narrowRouteNow()) return undefined;
  // The definer needs the acting login, which the identity readers answer
  // only off the narrow role (0322): the full-route spot acting-login.
  return atActingLogin((login) =>
    withSystemTx(async (tx) => {
      const rows = (await tx.execute(
        sql`select found, messages, digests from mantle_agent_delete(${login}::uuid,
            ${ownerId}::uuid, ${agentId}::uuid, ${conversation})`,
      )) as unknown as { found: boolean; messages: number; digests: number }[];
      const r = rows[0];
      return r?.found ? { messages: Number(r.messages), digests: Number(r.digests) } : null;
    }),
  );
}
