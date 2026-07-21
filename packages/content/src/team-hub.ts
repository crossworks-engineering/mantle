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
import { and, eq, gt, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { apps, db, nodes, pages, shares } from '@mantle/db';

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
export async function listTeamApps(ownerId: string, excludeAppId?: string): Promise<TeamAppCard[]> {
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

// ─── Team workspace (the /team read-only workspace surface) ─────────────────

/** Node types the member workspace lists as sections. `branch` = shared files
 *  folders (the footer's folder chips + the Files section). A whitelist so a
 *  new node type never leaks into the member surface by default. */
export const TEAM_WORKSPACE_TYPES = [
  'note',
  'page',
  'table',
  'app',
  'task',
  'event',
  'branch',
] as const;
export type TeamWorkspaceType = (typeof TEAM_WORKSPACE_TYPES)[number];

export type TeamVisibleShare = {
  /** Share token — the workspace opens /s/<token>. */
  token: string;
  nodeId: string;
  title: string;
  icon: string | null;
  summary: string | null;
  updatedAt: string;
  /** 'team' or 'public' — a member may open both, the badge tells them apart. */
  mode: 'team' | 'public';
  /** Parent node id — lets the pages section rebuild the sub-page tree over
   *  the SHARED subset (an unshared parent leaves its children as roots). */
  parentId: string | null;
  tags: string[];
};

/** Sort orders offered by the /team section list. `newest`/`oldest` rank by
 *  when the OWNER shared (share createdAt); `updated` by the node's last edit;
 *  `title` alphabetically. Default is `newest`. */
export const TEAM_SHARE_SORTS = ['newest', 'oldest', 'updated', 'title'] as const;
export type TeamShareSort = (typeof TEAM_SHARE_SORTS)[number];

/** One page of a section list plus the unpaged total (for the pager). */
export type TeamVisibleSharePage = {
  items: TeamVisibleShare[];
  total: number;
};

/** The active-share predicate shared by every team-visible listing: owned by
 *  this brain, of this type, not revoked, not expired. */
function teamShareVisiblePredicate(ownerId: string, nodeType: TeamWorkspaceType): SQL {
  return and(
    eq(shares.ownerId, ownerId),
    eq(shares.nodeType, nodeType),
    isNull(shares.revokedAt),
    or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
  )!;
}

/** Chars of doc_text the share queries pull as excerpt material — slack above
 *  {@link EXCERPT_MAX} so the word-boundary trim has room to cut. */
const DOC_TEXT_HEAD_CHARS = 280;

/** Chars kept of a doc_text fallback excerpt (before the trailing ellipsis). */
const EXCERPT_MAX = 240;

const teamShareColumns = {
  token: shares.token,
  nodeId: nodes.id,
  title: nodes.title,
  data: nodes.data,
  updatedAt: nodes.updatedAt,
  settings: shares.settings,
  parentId: nodes.parentId,
  tags: nodes.tags,
  // Fallback material for pages whose LLM summary is missing (never indexed,
  // or in the commit→re-extract window where commitPage just cleared it): the
  // head of the published plaintext rendering. NULL for non-page types (left
  // join misses) and for pages with no committed text.
  docTextHead: sql<string | null>`LEFT(${pages.docText}, ${DOC_TEXT_HEAD_CHARS})`,
} as const;

/** Reduce the head of a page's doc_text to a one-liner excerpt: markdown
 *  heading markers stripped, whitespace collapsed, cut at a word boundary with
 *  a trailing ellipsis whenever the source ran longer. Null for blank/absent. */
export function excerptFromDocText(head: string | null): string | null {
  if (!head) return null;
  // The SQL LEFT() counts Postgres chars, JS .length UTF-16 units (only ever
  // ≥ that), so `>=` reliably detects "the head was cut from a longer doc" —
  // an astral-heavy shorter head can misclassify, costing only an ellipsis.
  const headCut = head.length >= DOC_TEXT_HEAD_CHARS;
  const flat = head
    .replace(/^#{1,6}\s+/gm, '') // doc_text renders headings as '# …'
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length === 0) return null;
  if (flat.length <= EXCERPT_MAX && !headCut) return flat;
  // Truncated — by the char cap here, or upstream by the SQL head cut (whose
  // raw cut can land mid-word even when flattening shrank the text under the
  // cap: heading markers and blank runs collapse). Either way, drop the
  // possibly-partial last token and show the ellipsis.
  const cut = flat.slice(0, EXCERPT_MAX);
  // Relative threshold (not EXCERPT_MAX-based): a short-but-SQL-cut text must
  // still drop its final token, and a space-free blob keeps everything rather
  // than chopping to nothing.
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > cut.length / 2 ? lastSpace : cut.length).trimEnd()}…`;
}

function mapTeamShareRow(r: {
  token: string;
  nodeId: string;
  title: string;
  data: Record<string, unknown> | null;
  updatedAt: Date;
  settings: unknown;
  parentId: string | null;
  tags: string[] | null;
  docTextHead: string | null;
}): TeamVisibleShare {
  const summary =
    typeof r.data?.summary === 'string' && r.data.summary.trim() !== ''
      ? (r.data.summary as string)
      : excerptFromDocText(r.docTextHead);
  return {
    token: r.token,
    nodeId: r.nodeId,
    title: r.title,
    icon: typeof r.data?.icon === 'string' ? (r.data.icon as string) : null,
    summary,
    updatedAt: r.updatedAt.toISOString(),
    mode: (r.settings as Record<string, unknown>)?.mode === 'team' ? 'team' : 'public',
    parentId: r.parentId,
    tags: r.tags ?? [],
  };
}

/**
 * Every share of one type a TEAM MEMBER may open: ALL active shares — team
 * mode (members are exactly who it admits) and public mode (anyone with the
 * link, so a member too). Newest first. This is the UNPAGED listing (the shell
 * bootstrap's folder chips; the section list uses {@link pageTeamVisibleShares}).
 * The share stays the single source of truth for what the team may read (same
 * principle as {@link listTeamHubSections}).
 *
 * Note: for `app` shares the listing does not re-check the published build —
 * a broken-build app 404s at its /s reader instead (loadShareView guards it).
 */
export async function listTeamVisibleShares(
  ownerId: string,
  nodeType: TeamWorkspaceType,
): Promise<TeamVisibleShare[]> {
  const rows = await db
    .select(teamShareColumns)
    .from(shares)
    .innerJoin(nodes, eq(shares.nodeId, nodes.id))
    .leftJoin(pages, eq(pages.nodeId, nodes.id))
    .where(teamShareVisiblePredicate(ownerId, nodeType))
    .orderBy(sql`${shares.createdAt} DESC`);
  return rows.map(mapTeamShareRow);
}

/**
 * A searched, sorted, paginated page of one section's team-visible shares plus
 * the unpaged `total` — the data behind the /team workspace section list. Same
 * visibility rule as {@link listTeamVisibleShares}; `query` matches the title
 * or summary (case-insensitive substring).
 */
export async function pageTeamVisibleShares(
  ownerId: string,
  nodeType: TeamWorkspaceType,
  opts: {
    query?: string;
    tag?: string;
    sort?: TeamShareSort;
    limit: number;
    offset: number;
    /** Skip the unpaged count(*) when the caller has no pager (curated
     *  sections fan out per tag — `total` would just be thrown away). The
     *  returned `total` is then the fetched row count. */
    skipTotal?: boolean;
  },
): Promise<TeamVisibleSharePage> {
  const { query, tag, sort = 'newest', limit, offset, skipTotal = false } = opts;
  const search = query?.trim()
    ? or(
        ilike(nodes.title, `%${query.trim()}%`),
        sql`${nodes.data} ->> 'summary' ILIKE ${`%${query.trim()}%`}`,
      )
    : undefined;
  const tagCond = tag?.trim() ? sql`${tag.trim()} = ANY(${nodes.tags})` : undefined;
  const where = and(teamShareVisiblePredicate(ownerId, nodeType), search, tagCond);

  const orderBy =
    sort === 'oldest'
      ? sql`${shares.createdAt} ASC`
      : sort === 'updated'
        ? sql`${nodes.updatedAt} DESC`
        : sort === 'title'
          ? sql`lower(${nodes.title}) ASC`
          : sql`${shares.createdAt} DESC`;

  const [rows, totals] = await Promise.all([
    db
      .select(teamShareColumns)
      .from(shares)
      .innerJoin(nodes, eq(shares.nodeId, nodes.id))
      .leftJoin(pages, eq(pages.nodeId, nodes.id))
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset),
    skipTotal
      ? Promise.resolve(null)
      : db
          .select({ count: sql<number>`count(*)::int` })
          .from(shares)
          .innerJoin(nodes, eq(shares.nodeId, nodes.id))
          .where(where),
  ]);

  return {
    items: rows.map(mapTeamShareRow),
    total: totals ? (totals[0]?.count ?? 0) : rows.length,
  };
}

/** Distinct tags across one type's team-visible shares with usage counts —
 *  drives the section's tag filter (the /pages listPageTags counterpart,
 *  scoped to what the team may actually open). */
export async function listTeamShareTags(
  ownerId: string,
  nodeType: TeamWorkspaceType,
): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tags: nodes.tags })
    .from(shares)
    .innerJoin(nodes, eq(shares.nodeId, nodes.id))
    .where(teamShareVisiblePredicate(ownerId, nodeType));
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Items per curated Dashboard tag section. */
export const TEAM_CURATED_SECTION_LIMIT = 5;

export type CuratedTeamSection = {
  /** The curated tag — the section heading (display-cased by the UI). */
  tag: string;
  /** Up to {@link TEAM_CURATED_SECTION_LIMIT} team-visible page shares carrying
   *  the tag, newest node update first. */
  items: TeamVisibleShare[];
};

/**
 * The member Dashboard's curated sections: one per owner-picked tag
 * (prefs.teamHubTags, in pref order), each listing up to
 * {@link TEAM_CURATED_SECTION_LIMIT} team-visible PAGE shares carrying that
 * tag, newest-updated first. Same visibility rule as every other team listing
 * ({@link teamShareVisiblePredicate}) — team AND public mode shares qualify,
 * so the pref can never surface anything the owner didn't already share.
 * Tags whose visible set is empty are dropped (an unshared/untagged section
 * silently disappears rather than rendering a hollow heading).
 *
 * Pages-only on purpose for now; tags + shares are node-generic, so widening
 * to other types later is a per-section type option, not a redesign.
 */
export async function curatedTeamSections(
  ownerId: string,
  tags: string[],
): Promise<CuratedTeamSection[]> {
  const pagesPerTag = await Promise.all(
    tags.map((tag) =>
      pageTeamVisibleShares(ownerId, 'page', {
        tag,
        sort: 'updated',
        limit: TEAM_CURATED_SECTION_LIMIT,
        offset: 0,
        skipTotal: true, // no pager here — one query per tag, not two
      }),
    ),
  );
  return tags
    .map((tag, i) => ({ tag, items: pagesPerTag[i]?.items ?? [] }))
    .filter((s) => s.items.length > 0);
}

/** Per-type counts of team-visible (active) shares — the workspace nav badges
 *  and overview tiles. Same predicate as {@link listTeamVisibleShares}. */
export async function countTeamVisibleShares(
  ownerId: string,
): Promise<Record<TeamWorkspaceType, number>> {
  const rows = await db
    .select({ type: shares.nodeType, count: sql<number>`count(*)::int` })
    .from(shares)
    .where(
      and(
        eq(shares.ownerId, ownerId),
        isNull(shares.revokedAt),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
      ),
    )
    .groupBy(shares.nodeType);
  const counts = Object.fromEntries(TEAM_WORKSPACE_TYPES.map((t) => [t, 0])) as Record<
    TeamWorkspaceType,
    number
  >;
  for (const r of rows) {
    if ((TEAM_WORKSPACE_TYPES as readonly string[]).includes(r.type)) {
      counts[r.type as TeamWorkspaceType] = r.count;
    }
  }
  return counts;
}
