/**
 * Apps for members (member logins Phase 4b, plan v3.1 section 4a; workspaces
 * W5b2). A member RUNS apps; a member never creates, edits, builds,
 * publishes, shares or deletes one. What a member may run: an app a
 * workspace of theirs holds (its grant), with a green PUBLISHED build. Never
 * a draft. A public link tells nothing about who else runs it: a member with
 * the link and no grant opens it as anyone with the link does.
 *
 * The workspaces of the member: in a workspace scope, the scope's own. With
 * no workspace scope (system work) there is no member to ask about, so
 * nothing is reached (fail closed; it read the built-in Team workspace's
 * grant until 0286 made Team a normal workspace). Every member path holds
 * the login's scope (session.ts, the MCP scope entry mcp-core mcp-scope.ts, the turn scopes). The rule is written in every query here,
 * not left to row security alone: the db broker runs the app's SQLite on the
 * admin pool (the registry rows it writes are admin), and row security does
 * not reach SQLite.
 *
 * Writing the app's data: a member writes when they may edit the app (a
 * Moderator of its home, or a workspace of theirs holds it with Write on)
 * AND the app is not informational (`apps.data_read_only`). Informational writes no grant
 * (contract change 36): while it is on nobody beyond Admin writes the data,
 * whatever the grants say; off, the grants' Write decides.
 *
 * Only granted columns are read (never `apps.draft_*`), so these work on the
 * viewer roles.
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import {
  apps,
  currentWorkspaceScope,
  db,
  mayEditSql,
  mayReadInSql,
  nodeReadByWorkspace,
  nodes,
  sharedWorkspacesSql,
  wsArraySql,
  workspaces,
  type AppManifest,
  type BuildRef,
  liveWorkspace,
} from '@mantle/db';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import type { AppTint, MemberAppCard, MemberHomeApp } from '@mantle/client-types';
import type { AppPlace } from './app-folders';
import { dataAccessOf } from './app-data-access';

/** One launcher card: the published contract type. */
export type { MemberAppCard };

/** A runnable app: what the frame and the brokers need, published only. */
export type MemberRunnableApp = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  /** The member may edit it (a Moderator of its home, or a grant with Write
   *  on) and it is not informational: the member writes its data (else
   *  reads only). */
  writable: boolean;
  manifest: AppManifest;
  publishedBuild: BuildRef;
  /** apps.data_read_only, as stored (shown on the owner's app page). */
  dataReadOnly: boolean;
};

/** A workspace of the member reads the app (its grant). */
export function memberReachSql(): SQL<boolean> {
  const scope = currentWorkspaceScope();
  if (scope) return mayReadInSql(undefined, wsArraySql(scope.ws));
  return sql<boolean>`false`;
}

/** The member may edit the app (docs/workspaces.md, Apps, Data): a
 *  Moderator of its home or a grant with Write on, the database's own rule
 *  (mantle_may_edit, over the scope's settings), and the app is not
 *  informational. Over `nodes` joined to `apps` (every caller joins them):
 *  `apps.data_read_only` is an AND here, never a grant change. */
export function memberWritesSql(): SQL<boolean> {
  const scope = currentWorkspaceScope();
  const notInformational = sql`not coalesce(${apps.dataReadOnly}, false)`;
  if (scope) {
    return sql<boolean>`(${notInformational} and ${mayEditSql()})`;
  }
  // No workspace scope means no login to ask "Moderator of the home" of:
  // nothing writes (it kept the old Team grant's Write until 0286). No
  // member path reaches it: a member's app run and its MCP app_data_* calls
  // always hold the login's scope (session.ts, mcp-core mcp-scope.ts).
  return sql<boolean>`false`;
}

/**
 * May a member WRITE this app's database? They may edit the app (a
 * Moderator of its home, or a grant with Write on), and it is not
 * informational (`writable`, memberWritesSql);
 * a member-built app under review is read only (server/web/lib/member-apps.ts
 * sets it).
 */
export function memberMayWriteAppData(app: { writable: boolean }): boolean {
  return app.writable === true;
}

const publishedGreen = sql`(${apps.publishedBuild}->>'ok')::boolean is true`;

/** `ws` (a checked id, parseWsFilter) keeps only the apps that workspace
 *  holds, on top of the member's own reach: a workspace's landing page
 *  (task d78e7bde). */
function runnableWhere(anchorId: string, ws?: string | null) {
  return and(
    eq(nodes.ownerId, anchorId),
    eq(nodes.type, 'app'),
    memberReachSql(),
    publishedGreen,
    ws ? nodeReadByWorkspace(ws) : undefined,
  );
}

/** The apps a member's launcher lists, by title: those a workspace of
 *  theirs holds (`ws`: only those that workspace holds). */
export async function listMemberApps(
  anchorId: string,
  opts: { ws?: string | null } = {},
): Promise<MemberAppCard[]> {
  return (await listMemberAppsPlaced(anchorId, opts)).apps;
}

/** The same list, with the folder path of each app: what the launcher's
 *  folders are built from (./app-folders.ts). The paths stay on the brain. */
export async function listMemberAppsPlaced(
  anchorId: string,
  opts: { ws?: string | null } = {},
): Promise<{ apps: MemberAppCard[]; places: AppPlace[] }> {
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      path: sql<string>`${nodes.path}::text`,
      data: nodes.data,
      updatedAt: nodes.updatedAt,
      manifest: apps.manifest,
      writable: memberWritesSql(),
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(runnableWhere(anchorId, opts.ws))
    .orderBy(asc(nodes.title))
    .limit(500);
  const places: AppPlace[] = [];
  const cards = rows.map((r): MemberAppCard => {
    places.push({ id: r.id, path: r.path });
    const mayWrite = r.writable === true;
    const d = (r.data ?? {}) as Record<string, unknown>;
    const description = (r.manifest as AppManifest | null)?.description;
    return {
      id: r.id,
      title: r.title,
      icon: projectAppIcon(d.icon) ?? null,
      color: projectAppTint(d.color) ?? null,
      description: typeof description === 'string' && description.trim() ? description : null,
      updatedAt: r.updatedAt.toISOString(),
      dataReadOnly: !mayWrite,
      dataAccess: dataAccessOf(mayWrite),
    };
  });
  return { apps: cards, places };
}

/** One app a member may run, or null: not an app, no workspace of theirs
 *  holds it, no green published build, or not this brain's (`ws`: or that
 *  workspace does not hold it). The same null for all of them. */
export async function getMemberRunnableApp(
  anchorId: string,
  appId: string,
  opts: { ws?: string | null } = {},
): Promise<MemberRunnableApp | null> {
  const [row] = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      data: nodes.data,
      manifest: apps.manifest,
      publishedBuild: apps.publishedBuild,
      dataReadOnly: apps.dataReadOnly,
      writable: memberWritesSql(),
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.id, appId), runnableWhere(anchorId, opts.ws)))
    .limit(1);
  if (!row?.publishedBuild?.ok) return null;
  const d = (row.data ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    title: row.title,
    icon: projectAppIcon(d.icon) ?? null,
    color: projectAppTint(d.color) ?? null,
    writable: row.writable === true,
    manifest: (row.manifest ?? {}) as AppManifest,
    publishedBuild: row.publishedBuild,
    dataReadOnly: row.dataReadOnly === true,
  };
}

/**
 * Ids of the apps a workspace of the member holds (published or not): the
 * apps whose data a team surface may read (team-read app_db_list /
 * app_db_query). Its own grant only: an app's grants never follow an embed,
 * so an embed in a shared item never opens an app's database (access matrix
 * audit, M6).
 */
export async function listTeamLevelAppIds(anchorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, anchorId), eq(nodes.type, 'app'), memberReachSql()));
  return new Set(rows.map((r) => r.id));
}

/**
 * A workspace's home app (task d78e7bde; was the brain-wide member home app
 * of plan 4a): the app the workspace names as its landing page
 * (workspaces.landing_app_id, set on the workspace screen by a Moderator),
 * honoured only while the workspace holds it, its published build is green
 * and the reader may run it. No share is needed: the grant is the access.
 * Null means the landing page shows the Built-in home.
 */
export async function resolveMemberHomeApp(
  anchorId: string,
  homeAppId: string | null | undefined,
  ws?: string | null,
): Promise<MemberHomeApp | null> {
  if (!homeAppId) return null;
  const app = await getMemberRunnableApp(anchorId, homeAppId, { ws });
  return app ? { appId: app.id, title: app.title, icon: app.icon, color: app.color } : null;
}

/**
 * An app as a workspace's home app, read for the workspace screen and for
 * the landing setting (task d78e7bde): `appId` is an app of this brain that
 * workspace `ws` holds, with `ready` true when its published build is green.
 * Null when it is not one: no app, another brain's, or `ws` does not hold
 * it. Only the workspace's own grant counts, never the reader's other
 * workspaces: the workspace's users must all be able to open it. Runs where
 * the caller runs (the workspace routes read on the system pool, with the
 * rule in the query), on `q` when given: the setter's transaction, which
 * holds the workspace row.
 */
export async function workspaceHeldApp(
  anchorId: string,
  ws: string,
  appId: string,
  q: Pick<typeof db, 'select'> = db,
): Promise<{ appId: string; title: string; ready: boolean } | null> {
  const [row] = await q
    .select({ id: nodes.id, title: nodes.title, ready: publishedGreen })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.id, appId),
        eq(nodes.ownerId, anchorId),
        eq(nodes.type, 'app'),
        nodeReadByWorkspace(ws),
      ),
    )
    .limit(1);
  return row ? { appId: row.id, title: row.title, ready: row.ready === true } : null;
}

/** The home app id workspace `ws` names (workspaces.landing_app_id, task
 *  d78e7bde), read where the caller runs: in a login's scope the row rule
 *  answers null for a workspace it is not in. Null: the Built-in home. */
export async function workspaceLandingAppId(anchorId: string, ws: string): Promise<string | null> {
  const [row] = await db
    .select({ appId: workspaces.landingAppId })
    .from(workspaces)
    .where(and(eq(workspaces.id, ws), eq(workspaces.ownerId, anchorId), liveWorkspace()))
    .limit(1);
  return row?.appId ?? null;
}

/** The login's first shared workspace, read where the caller runs (in a
 *  login's scope, its own workspaces): the oldest live one that is shared
 *  (sharedWorkspacesSql: neither Admin, nor private, nor a Former user
 *  one), else null. What GET /api/member/home answers for
 *  an app older than per-workspace landing pages; on a brain switched
 *  before 0286 that is the Team workspace, which holds the old brain-wide
 *  member home app (0276). No workspace is special: it is only the oldest. */
export async function firstSharedWorkspaceId(anchorId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.ownerId, anchorId),
        liveWorkspace(),
        sharedWorkspacesSql(sql`array[${workspaces.id}]`),
      ),
    )
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return row?.id ?? null;
}
