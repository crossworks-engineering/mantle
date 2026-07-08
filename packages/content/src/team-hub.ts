/**
 * Team Hub reads — the data behind the /team landing surface.
 *
 * The hub's briefing sections are simply the owner's ACTIVE, TEAM-mode page
 * shares: sharing a page with "team members only" puts it on the hub, revoking
 * the link takes it off. No separate hub config exists on purpose — the share
 * is the single source of truth for what the team may read, so the hub can
 * never show more than the owner explicitly shared (docs/sharing.md).
 *
 * Stats are coarse per-type node counts — headline numbers for the hub's
 * stat tiles, never content. Callers are team-authenticated routes.
 */
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, nodes, shares } from '@mantle/db';

export type TeamHubSection = {
  /** Share token — the hub links to /s/<token>. */
  token: string;
  title: string;
  icon: string | null;
  summary: string | null;
  updatedAt: string;
};

/**
 * The owner's team-shared pages, oldest share first — the owner curates hub
 * order by the order they shared (Vision first, then the rest).
 */
export async function listTeamHubSections(ownerId: string): Promise<TeamHubSection[]> {
  const rows = await db
    .select({
      token: shares.token,
      title: nodes.title,
      data: nodes.data,
      updatedAt: nodes.updatedAt,
    })
    .from(shares)
    .innerJoin(nodes, eq(shares.nodeId, nodes.id))
    .where(
      and(
        eq(shares.ownerId, ownerId),
        eq(shares.nodeType, 'page'),
        sql`${shares.settings}->>'mode' = 'team'`,
        isNull(shares.revokedAt),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
      ),
    )
    .orderBy(shares.createdAt);
  return rows.map((r) => ({
    token: r.token,
    title: r.title,
    icon: typeof r.data?.icon === 'string' ? (r.data.icon as string) : null,
    summary: typeof r.data?.summary === 'string' ? (r.data.summary as string) : null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Node types surfaced as hub stat tiles, in display order. A whitelist so a
 *  new sensitive node type never leaks into the hub by default. */
export const TEAM_HUB_STAT_TYPES = [
  'page',
  'note',
  'file',
  'table',
  'task',
  'event',
  'journal',
  'contact',
  'email',
] as const;
export type TeamHubStatType = (typeof TEAM_HUB_STAT_TYPES)[number];

/** Per-type node counts for the hub tiles (whitelisted types only). */
export async function teamHubContentCounts(
  ownerId: string,
): Promise<Record<TeamHubStatType, number>> {
  const rows = await db
    .select({ type: nodes.type, count: sql<number>`count(*)::int` })
    .from(nodes)
    .where(eq(nodes.ownerId, ownerId))
    .groupBy(nodes.type);
  const counts = Object.fromEntries(TEAM_HUB_STAT_TYPES.map((t) => [t, 0])) as Record<
    TeamHubStatType,
    number
  >;
  for (const r of rows) {
    if ((TEAM_HUB_STAT_TYPES as readonly string[]).includes(r.type)) {
      counts[r.type as TeamHubStatType] = r.count;
    }
  }
  return counts;
}
