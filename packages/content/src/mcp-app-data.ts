/**
 * Which apps a member's or client's MCP connection may reach (team apps
 * Phase 1, plan page b6dd688e, section B; workspaces W5b2). The rule: MCP
 * gives a login exactly what the app's own broker gives them in the browser,
 * and only on an app whose MCP access switch is on.
 *
 *  - Member: an app a workspace of theirs holds (member-apps.ts), with a
 *    green PUBLISHED build (never a draft) and `apps.mcp_access` on. Write:
 *    the grant's Write switch (Informational is Write off).
 *  - Client: an app the client portal gives them (client-apps.ts; clients
 *    are not migrated), with `apps.mcp_access` on. Write: unless the app is
 *    informational.
 *
 * The login's Write switch is the MCP surface's part: without it the write
 * tool is never offered. The rule is written in the query, and the callers
 * run it on the login's viewer role, so row security holds as well. Only
 * granted columns are read (never `apps.draft_*`).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { apps, db, nodes, type AppManifest } from '@mantle/db';
import { getClientRunnableApp, listClientApps } from './client-apps';
import { memberReachSql, memberWritesSql } from './member-apps';

export type McpDataRole = 'member' | 'client';

/** One app a login's MCP may reach. */
export type McpDataApp = {
  id: string;
  title: string;
  /** Whether this login may write its rows (before the Write switch). */
  writable: boolean;
  manifest: AppManifest;
};

/** At most this many apps in one list. */
export const MCP_DATA_APPS_MAX = 200;

const published = sql`(${apps.publishedBuild}->>'ok')::boolean is true`;

function memberWhere(anchorId: string) {
  return and(
    eq(nodes.ownerId, anchorId),
    eq(nodes.type, 'app'),
    memberReachSql(),
    published,
    eq(apps.mcpAccess, true),
  );
}

function memberCols() {
  return {
    id: nodes.id,
    title: nodes.title,
    manifest: apps.manifest,
    writable: memberWritesSql(),
  };
}

type MemberRow = {
  id: string;
  title: string;
  manifest: AppManifest | null;
  writable: boolean | null;
};

function memberApp(r: MemberRow): McpDataApp {
  return { id: r.id, title: r.title, writable: r.writable === true, manifest: r.manifest ?? {} };
}

/** The apps of `ids` with MCP access on, with their manifests (a client's
 *  reach). */
async function mcpOpen(ids: readonly string[]): Promise<Map<string, AppManifest>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: apps.nodeId, manifest: apps.manifest })
    .from(apps)
    .where(and(inArray(apps.nodeId, [...ids]), eq(apps.mcpAccess, true)));
  return new Map(rows.map((r) => [r.id, r.manifest ?? {}]));
}

/** The apps this login's MCP may reach, by title. */
export async function listMcpDataApps(anchorId: string, role: McpDataRole): Promise<McpDataApp[]> {
  if (role === 'client') {
    const cards = await listClientApps(anchorId);
    const open = await mcpOpen(cards.map((c) => c.id));
    return cards
      .flatMap((c): McpDataApp[] => {
        const manifest = open.get(c.id);
        return manifest ? [{ id: c.id, title: c.title, writable: !c.dataReadOnly, manifest }] : [];
      })
      .slice(0, MCP_DATA_APPS_MAX);
  }
  const rows: MemberRow[] = await db
    .select(memberCols())
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(memberWhere(anchorId))
    .orderBy(asc(nodes.title))
    .limit(MCP_DATA_APPS_MAX);
  return rows.map(memberApp);
}

/** One app this login's MCP may reach, or null: no such app, not this
 *  brain's, not the login's, no green published build, or MCP access off.
 *  The same null for all of them. */
export async function getMcpDataApp(
  anchorId: string,
  role: McpDataRole,
  appId: string,
): Promise<McpDataApp | null> {
  if (role === 'client') {
    const app = await getClientRunnableApp(anchorId, appId);
    if (!app || !(await mcpOpen([app.id])).has(app.id)) return null;
    // The runnable app's own (published) manifest.
    return { id: app.id, title: app.title, writable: !app.dataReadOnly, manifest: app.manifest };
  }
  const [row]: MemberRow[] = await db
    .select(memberCols())
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.id, appId), memberWhere(anchorId)))
    .limit(1);
  return row ? memberApp(row) : null;
}
