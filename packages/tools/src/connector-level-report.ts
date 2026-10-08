/**
 * The read-only check before a box rolls to team apps Phase 2 ("count, then
 * fix in roll", Jason 2026-10-08). Phase 2 lets a connector's level decide
 * who may use its tools, where External access decided before. Nothing
 * raises a level by itself, so on a box two things can change:
 *
 *  - LOSES: an app run below admin that could call a connector tool before
 *    (External access on) is refused now, because the connector sits above
 *    the run's level (it starts at admin). An admin raises the connector's
 *    level, with Jason's OK, before or right after the roll.
 *  - OPENS: a connector already below admin (team, client or public) now
 *    gives its tools to the members' or clients' own MCP and to their app
 *    runs; a tool without the read-only mark is a WRITE.
 *
 * Numbers and ids only (app node ids, tool group ids): no titles, slugs or
 * names, so the output is safe to paste from a client box. It reads; it
 * writes nothing.
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  apps,
  db,
  nodes,
  shares,
  toolGroups,
  tools,
  asViewerLevel,
  type Tool,
  type ToolHandler,
  type ViewerLevel,
} from '@mantle/db';
import { connectorLevelAllows, externalAccessActive } from './external-access';

/** One app run below admin, and what Phase 2 changes for it. */
export type ConnectorLevelAppRow = {
  appId: string;
  /** Who runs it below admin: member (a team or public app), client (a
   *  client app), contact (a contact-share link). */
  runner: 'member' | 'client' | 'contact';
  /** The connector tools it declares that were allowed before and are
   *  refused now, with their connector group ids. */
  loses: { groupId: string; count: number }[];
  /** The connector tools it declares that were refused before and are
   *  allowed now. Each is a WRITE: a tool with the read-only mark had
   *  External access, so it was allowed before. */
  opens: { groupId: string; writes: number }[];
};

export type ConnectorLevelGroupRow = {
  groupId: string;
  level: ViewerLevel;
  enabled: boolean;
  /** Its enabled tools with the read-only mark, and without (writes). */
  reads: number;
  writes: number;
};

export type ConnectorLevelReport = {
  /** Apps with a change, by app and runner. */
  apps: ConnectorLevelAppRow[];
  /** Connector groups below admin: open to logins' MCP and app runs now. */
  openGroups: ConnectorLevelGroupRow[];
  totals: {
    appsLosing: number;
    toolsLosing: number;
    appsOpening: number;
    openGroups: number;
    openWriteTools: number;
  };
};

const RUN_LEVEL = { member: 'team', client: 'client', contact: 'public' } as const;

/** The report for one brain. */
export async function connectorLevelReport(ownerId: string): Promise<ConnectorLevelReport> {
  const groups = await db
    .select({
      id: toolGroups.id,
      slug: toolGroups.slug,
      audience: toolGroups.audience,
      enabled: toolGroups.enabled,
      integration: toolGroups.integration,
    })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), sql`${toolGroups.integration} ? 'mcp'`));
  const groupBySlug = new Map(groups.map((g) => [g.slug, g]));

  const mcpTools = (await db
    .select()
    .from(tools)
    .where(
      and(
        eq(tools.ownerId, ownerId),
        eq(tools.enabled, true),
        sql`${tools.handler}->>'kind' = 'mcp'`,
      ),
    )) as Tool[];
  const toolBySlug = new Map(mcpTools.map((t) => [t.slug, t]));

  const openGroups: ConnectorLevelGroupRow[] = [];
  for (const g of groups) {
    const level = asViewerLevel(g.audience);
    if (level === 'admin') continue;
    const own = mcpTools.filter(
      (t) => (t.handler as ToolHandler & { group?: string }).group === g.slug,
    );
    const reads = own.filter((t) => externalAccessActive(t)).length;
    openGroups.push({
      groupId: g.id,
      level,
      enabled: g.enabled === true,
      reads,
      writes: own.length - reads,
    });
  }

  // Apps run below admin: their level (own or a folder's share), and the
  // apps with a live contact share.
  const appRows = await db
    .select({
      id: nodes.id,
      audience: nodes.audience,
      inherited: nodes.inheritedLevel,
      manifest: apps.manifest,
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')));
  const contactShared = new Set(
    (
      await db
        .select({ nodeId: shares.nodeId })
        .from(shares)
        .where(and(isNotNull(shares.contactId), isNull(shares.revokedAt)))
    ).map((r) => r.nodeId),
  );

  const rows: ConnectorLevelAppRow[] = [];
  for (const app of appRows) {
    const declared = (app.manifest?.toolSlugs ?? []).filter((s) => toolBySlug.has(s));
    if (!declared.length) continue;
    const own = asViewerLevel(app.audience);
    const shared = app.inherited ? asViewerLevel(app.inherited) : null;
    const levels = new Set([own, ...(shared ? [shared] : [])]);
    const runners: ConnectorLevelAppRow['runner'][] = [];
    if (levels.has('client')) runners.push('client');
    else if (levels.has('team') || levels.has('public')) runners.push('member');
    if (contactShared.has(app.id)) runners.push('contact');
    for (const runner of runners) {
      const loses = new Map<string, number>();
      const opens = new Map<string, number>();
      for (const slug of declared) {
        const t = toolBySlug.get(slug)!;
        const g = groupBySlug.get((t.handler as ToolHandler & { group: string }).group);
        if (!g || t.requiresConfirm) continue;
        const before = externalAccessActive(t);
        const after =
          g.enabled === true && connectorLevelAllows(RUN_LEVEL[runner], asViewerLevel(g.audience));
        if (before && !after) loses.set(g.id, (loses.get(g.id) ?? 0) + 1);
        if (!before && after) opens.set(g.id, (opens.get(g.id) ?? 0) + 1);
      }
      if (loses.size || opens.size) {
        rows.push({
          appId: app.id,
          runner,
          loses: [...loses].map(([groupId, count]) => ({ groupId, count })),
          opens: [...opens].map(([groupId, writes]) => ({ groupId, writes })),
        });
      }
    }
  }

  return {
    apps: rows,
    openGroups,
    totals: {
      appsLosing: new Set(rows.filter((r) => r.loses.length).map((r) => r.appId)).size,
      toolsLosing: rows.reduce((n, r) => n + r.loses.reduce((m, l) => m + l.count, 0), 0),
      appsOpening: new Set(rows.filter((r) => r.opens.length).map((r) => r.appId)).size,
      openGroups: openGroups.length,
      openWriteTools: openGroups.reduce((n, g) => n + g.writes, 0),
    },
  };
}
