/**
 * Which apps a login's MCP connection may reach (team apps Phase 1, plan
 * page b6dd688e, section B; workspaces W5b2). The rule: MCP gives a login
 * exactly what the app's own broker gives them in the browser, and only on
 * an app whose MCP access switch is on: an app a workspace of theirs holds
 * (member-apps.ts), with a green PUBLISHED build (never a draft) and
 * `apps.mcp_access` on. Write: the grant's Write switch, and never while the
 * app is informational.
 *
 * The login's Write switch is the MCP surface's part: without it the write
 * tool is never offered. The rule is written in the query, and the callers
 * run it on the login's viewer role, so row security holds as well. Only
 * granted columns are read (never `apps.draft_*`).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { apps, db, nodes, type AppManifest } from '@mantle/db';
import { memberReachSql, memberWritesSql } from './member-apps';

/** Who the connection acts for: an admin or a member login. The reach rule
 *  is the same for both (their workspaces); the role is what the app sees
 *  in `:host_me_kind`. */
export type McpDataRole = 'admin' | 'member';

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

/** The apps this login's MCP may reach, by title. */
export async function listMcpDataApps(anchorId: string, _role: McpDataRole): Promise<McpDataApp[]> {
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
  _role: McpDataRole,
  appId: string,
): Promise<McpDataApp | null> {
  const [row]: MemberRow[] = await db
    .select(memberCols())
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.id, appId), memberWhere(anchorId)))
    .limit(1);
  return row ? memberApp(row) : null;
}
