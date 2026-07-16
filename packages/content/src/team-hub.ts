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
import { apps, db, nodes, shares } from '@mantle/db';

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
 *
 * Only the TOP-MOST team-shared page of a subtree becomes a card: a page whose
 * ancestor page is itself team-shared is left off (it stays openable via its
 * own link, e.g. from within the parent). This keeps "Share sub-pages" (subtree
 * cascade, docs/sharing.md) from turning every child into a hub card — the
 * parent card represents the whole subtree.
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
        // Exclude pages nested under another team-shared page (keep the top-most).
        sql`NOT EXISTS (
          SELECT 1 FROM ${shares} anc_s
            JOIN ${nodes} anc_n ON anc_n.id = anc_s.node_id
           WHERE anc_s.owner_id = ${ownerId}
             AND anc_s.node_type = 'page'
             AND anc_s.settings->>'mode' = 'team'
             AND anc_s.revoked_at IS NULL
             AND (anc_s.expires_at IS NULL OR anc_s.expires_at > now())
             AND anc_n.id <> ${nodes.id}
             AND ${nodes.path} <@ anc_n.path
        )`,
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

export type TeamHubApp = {
  /** The designated app's node id (== prefs.teamHubAppId). */
  appNodeId: string;
  /** Active team-mode share token — the shell's AppSandbox brokers through
   *  /s/<token>/{bundle,tool-broker,db-broker}. */
  shareToken: string;
};

/**
 * Resolve a brain's designated team-hub app to something the /team shell can
 * actually render. Honoured only when the WHOLE chain is intact:
 * pref (caller passes prefs.teamHubAppId) → app exists under this owner →
 * green PUBLISHED build → active TEAM-mode share. Any broken link ⇒ null ⇒
 * the built-in hub renders — designation must never produce a blank page.
 *
 * Read-only on purpose: share creation happens at designation time
 * (/team-admin), never as a side effect of a member loading the hub.
 */
export async function resolveTeamHubApp(
  ownerId: string,
  teamHubAppId: string | undefined,
): Promise<TeamHubApp | null> {
  if (!teamHubAppId) return null;
  const [row] = await db
    .select({ token: shares.token, publishedBuild: apps.publishedBuild })
    .from(shares)
    .innerJoin(apps, eq(apps.nodeId, shares.nodeId))
    .where(
      and(
        eq(shares.ownerId, ownerId),
        eq(shares.nodeId, teamHubAppId),
        eq(shares.nodeType, 'app'),
        sql`${shares.settings}->>'mode' = 'team'`,
        isNull(shares.revokedAt),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
      ),
    )
    .limit(1);
  if (!row || row.publishedBuild?.ok !== true) return null;
  return { appNodeId: teamHubAppId, shareToken: row.token };
}

export type TeamAppCard = {
  /** Share token — the hub launcher opens /s/<token>. */
  token: string;
  title: string;
  /** The app's manifest description, if the author set one. */
  description: string | null;
  updatedAt: string;
};

/**
 * The owner's team-shared apps — the /team hub's launcher cards. Same
 * share-is-the-source-of-truth model as briefing sections: an ACTIVE,
 * TEAM-mode app share lists the app, revoking the share delists it. Ordered
 * oldest share first (share order = display order, matching briefings).
 *
 * Only apps with a green PUBLISHED build are listed — a red build silently
 * delists rather than handing members a broken app. `excludeAppId` keeps the
 * designated hub app (prefs.teamHubAppId) off its own launcher.
 */
export async function listTeamApps(
  ownerId: string,
  excludeAppId?: string,
): Promise<TeamAppCard[]> {
  const rows = await db
    .select({
      token: shares.token,
      nodeId: shares.nodeId,
      title: nodes.title,
      manifest: apps.manifest,
      publishedBuild: apps.publishedBuild,
      updatedAt: nodes.updatedAt,
    })
    .from(shares)
    .innerJoin(nodes, eq(shares.nodeId, nodes.id))
    .innerJoin(apps, eq(apps.nodeId, shares.nodeId))
    .where(
      and(
        eq(shares.ownerId, ownerId),
        eq(shares.nodeType, 'app'),
        sql`${shares.settings}->>'mode' = 'team'`,
        isNull(shares.revokedAt),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
      ),
    )
    .orderBy(shares.createdAt);
  return rows
    .filter((r) => r.nodeId !== excludeAppId && r.publishedBuild?.ok === true)
    .map((r) => ({
      token: r.token,
      title: r.title,
      description:
        typeof r.manifest?.description === 'string' && r.manifest.description.trim() !== ''
          ? r.manifest.description
          : null,
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
