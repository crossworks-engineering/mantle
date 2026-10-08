/**
 * Which apps a member's or client's MCP connection may reach (team apps
 * Phase 1, plan page b6dd688e, section B). The rule: MCP gives a login
 * exactly what the app's own broker gives them in the browser, and only on
 * an app whose MCP access switch is on.
 *
 *  - Reach: an app the login may RUN (member: team, client or public level;
 *    client: client level; a green PUBLISHED build; never admin level, never
 *    a draft), with `apps.mcp_access` on.
 *  - Write: the role's browser write rule (member: a team or client app that
 *    is not informational; client: an app that is not informational). The
 *    login's Write switch is the MCP surface's part: without it the write
 *    tool is never offered.
 *
 * The rule is written in the query, as in member-apps.ts and client-apps.ts,
 * and the callers run it on the login's viewer role, so row security holds
 * as well. Only granted columns are read (never `apps.draft_*`).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { apps, db, nodes, type AppManifest, type ViewerLevel } from '@mantle/db';
import { CLIENT_APP_LEVELS } from './client-apps';
import { MEMBER_APP_LEVELS, memberMayWriteAppData } from './member-apps';
import { isReadAt, itemLevel, readAtSql } from './item-level';

export type McpDataRole = 'member' | 'client';

/** One app a login's MCP may reach. */
export type McpDataApp = {
  id: string;
  title: string;
  /** The level it is read at: its own, or its folder's share. */
  level: ViewerLevel;
  /** Whether this login may write its rows (before the Write switch). */
  writable: boolean;
  manifest: AppManifest;
};

/** At most this many apps in one list. */
export const MCP_DATA_APPS_MAX = 200;

/** As member-apps.ts: an app is used here (its database), not only read, so
 *  an embed in a shared item does not open it. */
const APP_READ = { embeds: false } as const;

function levelsFor(role: McpDataRole) {
  return role === 'member' ? MEMBER_APP_LEVELS : CLIENT_APP_LEVELS;
}

function reachWhere(anchorId: string, role: McpDataRole) {
  return and(
    eq(nodes.ownerId, anchorId),
    eq(nodes.type, 'app'),
    readAtSql(levelsFor(role), APP_READ),
    sql`(${apps.publishedBuild}->>'ok')::boolean is true`,
    eq(apps.mcpAccess, true),
  );
}

const cols = {
  id: nodes.id,
  title: nodes.title,
  audience: nodes.audience,
  inheritedLevel: nodes.inheritedLevel,
  manifest: apps.manifest,
  dataReadOnly: apps.dataReadOnly,
};

type Row = {
  id: string;
  title: string;
  audience: string;
  inheritedLevel: string | null;
  manifest: AppManifest | null;
  dataReadOnly: boolean | null;
};

function toApp(role: McpDataRole, r: Row): McpDataApp | null {
  // The query keeps to these levels already; a row outside them is never
  // reached, whatever the column holds.
  if (!isReadAt(r.audience, r.inheritedLevel, levelsFor(role))) return null;
  const level = itemLevel(r.audience, r.inheritedLevel);
  const dataReadOnly = r.dataReadOnly === true;
  return {
    id: r.id,
    title: r.title,
    level,
    writable:
      role === 'member' ? memberMayWriteAppData({ audience: level, dataReadOnly }) : !dataReadOnly,
    manifest: r.manifest ?? {},
  };
}

/** The apps this login's MCP may reach, by title. */
export async function listMcpDataApps(anchorId: string, role: McpDataRole): Promise<McpDataApp[]> {
  const rows: Row[] = await db
    .select(cols)
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(reachWhere(anchorId, role))
    .orderBy(asc(nodes.title))
    .limit(MCP_DATA_APPS_MAX);
  return rows.flatMap((r) => {
    const app = toApp(role, r);
    return app ? [app] : [];
  });
}

/** One app this login's MCP may reach, or null: no such app, not this
 *  brain's, above the login's level, no green published build, or MCP
 *  access off. The same null for all of them. */
export async function getMcpDataApp(
  anchorId: string,
  role: McpDataRole,
  appId: string,
): Promise<McpDataApp | null> {
  const [row]: Row[] = await db
    .select(cols)
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.id, appId), reachWhere(anchorId, role)))
    .limit(1);
  return row ? toApp(role, row) : null;
}
