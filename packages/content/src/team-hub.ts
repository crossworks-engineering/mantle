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
  /** Token of the nearest team-shared ANCESTOR page, or null when this is a
   *  top-level team page. Lets a hub surface nest a shared subtree under its
   *  top page (the built-in hub cards on top-level only; a hub app can render
   *  the whole tree). Every section is still an openable team-mode share. */
  parentToken: string | null;
};

/**
 * The owner's team-shared pages, oldest share first — the owner curates hub
 * order by the order they shared (Vision first, then the rest).
 *
 * The FULL set is returned (subtree children included), each tagged with the
 * `parentToken` of its nearest team-shared ancestor so a consumer can nest.
 * The built-in hub shows top-level (`parentToken == null`) as cards; a hub app
 * can render children under their parent. Sharing a subtree ("Share sub-pages",
 * docs/sharing.md) therefore makes every child reachable from the hub without
 * flooding the top level with a card each.
 */
export async function listTeamHubSections(ownerId: string): Promise<TeamHubSection[]> {
  const rows = await db
    .select({
      token: shares.token,
      title: nodes.title,
      data: nodes.data,
      updatedAt: nodes.updatedAt,
      // Deepest team-shared ancestor page's token (nearest parent), or null.
      parentToken: sql<string | null>`(
        SELECT anc_s.token
          FROM ${shares} anc_s
          JOIN ${nodes} anc_n ON anc_n.id = anc_s.node_id
         WHERE anc_s.owner_id = ${ownerId}
           AND anc_s.node_type = 'page'
           AND anc_s.settings->>'mode' = 'team'
           AND anc_s.revoked_at IS NULL
           AND (anc_s.expires_at IS NULL OR anc_s.expires_at > now())
           AND anc_n.id <> ${nodes.id}
           AND ${nodes.path} <@ anc_n.path
         ORDER BY nlevel(anc_n.path) DESC
         LIMIT 1
      )`,
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
    parentToken: r.parentToken ?? null,
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
