/**
 * Apps for members (member logins Phase 4b, plan v3.1 section 4a; workspaces
 * W5b2). A member RUNS apps; a member never creates, edits, builds,
 * publishes, shares or deletes one. What a member may run: an app a
 * workspace of theirs holds (its grant), with a green PUBLISHED build. Never
 * a draft. A public link tells nothing about who else runs it: a member with
 * the link and no grant opens it as anyone with the link does.
 *
 * The workspaces of the member: in a workspace scope, the scope's own; in a
 * team level scope (members until the scope shim moves them), the brain's
 * Team workspace (`teamReadsSql`). The rule is written in every query here,
 * not left to row security alone: the db broker runs the app's SQLite on the
 * admin pool (the registry rows it writes are admin), and row security does
 * not reach SQLite.
 *
 * Writing the app's data is the grant's Write switch (Informational is Write
 * off, set in the Grant Access panel): a member writes when a workspace of
 * theirs holds the app with Write on.
 *
 * Only granted columns are read (never `apps.draft_*`), so these work on the
 * viewer roles.
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import {
  apps,
  currentWorkspaceScope,
  db,
  nodes,
  teamReadsSql,
  teamWritesSql,
  type AppManifest,
  type BuildRef,
} from '@mantle/db';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import type { AppTint, MemberAppCard, MemberAppLevel, MemberHomeApp } from '@mantle/client-types';
import type { AppPlace } from './app-folders';
import { dataAccessOf } from './app-data-access';

/** The values of the launcher card's legacy level field (`MemberAppCard`,
 *  until W5c). Pinned to the published `MemberAppLevel` in
 *  server/web/lib/client-types-drift.test.ts. */
export const MEMBER_APP_LEVELS = [
  'team',
  'client',
  'public',
] as const satisfies readonly MemberAppLevel[];

/** One launcher card: the published contract type. */
export type { MemberAppCard };

/** A runnable app: what the frame and the brokers need, published only. */
export type MemberRunnableApp = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  /** A workspace of the member holds it with Write on: the member writes
   *  its data (else reads only). */
  writable: boolean;
  manifest: AppManifest;
  publishedBuild: BuildRef;
  /** apps.data_read_only, as stored (shown on the owner's app page). */
  dataReadOnly: boolean;
};

function wsArray(ws: readonly string[]): SQL {
  return sql`${`{${ws.join(',')}}`}::uuid[]`;
}

/** A workspace of the member reads the app (its grant). */
export function memberReachSql(): SQL<boolean> {
  const scope = currentWorkspaceScope();
  if (scope) return sql<boolean>`(${nodes.readWs} && ${wsArray(scope.ws)})`;
  return teamReadsSql();
}

/** A workspace of the member holds the app with Write on. */
export function memberWritesSql(): SQL<boolean> {
  const scope = currentWorkspaceScope();
  if (scope) return sql<boolean>`(${nodes.writeWs} && ${wsArray(scope.ws)})`;
  return teamWritesSql();
}

/**
 * May a member WRITE this app's database? The grant's Write switch of a
 * workspace of theirs (`writable`); a member-built app under review is read
 * only (server/web/lib/member-apps.ts sets it).
 */
export function memberMayWriteAppData(app: { writable: boolean }): boolean {
  return app.writable === true;
}

const publishedGreen = sql`(${apps.publishedBuild}->>'ok')::boolean is true`;

function runnableWhere(anchorId: string) {
  return and(eq(nodes.ownerId, anchorId), eq(nodes.type, 'app'), memberReachSql(), publishedGreen);
}

/** The apps a member's launcher lists, by title: those a workspace of
 *  theirs holds. */
export async function listMemberApps(anchorId: string): Promise<MemberAppCard[]> {
  return (await listMemberAppsPlaced(anchorId)).apps;
}

/** The same list, with the folder path of each app: what the launcher's
 *  folders are built from (./app-folders.ts). The paths stay on the brain. */
export async function listMemberAppsPlaced(
  anchorId: string,
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
    .where(runnableWhere(anchorId))
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
      // The card's legacy level field (the DTO keeps it until W5c): every
      // app a member is granted reads as team.
      audience: 'team',
      updatedAt: r.updatedAt.toISOString(),
      dataReadOnly: !mayWrite,
      dataAccess: dataAccessOf(mayWrite),
    };
  });
  return { apps: cards, places };
}

/** One app a member may run, or null: not an app, no workspace of theirs
 *  holds it, no green published build, or not this brain's. The same null
 *  for all of them. */
export async function getMemberRunnableApp(
  anchorId: string,
  appId: string,
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
    .where(and(eq(nodes.id, appId), runnableWhere(anchorId)))
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
 * The members' home app (plan 4a, "Hub app"): the app the brain pins as home
 * (the `teamHubAppId` pref, set in Team admin > Settings), honoured for a
 * member only while it is one they may run. No share is needed: the grant is
 * the access. Null means the member home shows its built-in view.
 */
export async function resolveMemberHomeApp(
  anchorId: string,
  homeAppId: string | undefined,
): Promise<MemberHomeApp | null> {
  if (!homeAppId) return null;
  const app = await getMemberRunnableApp(anchorId, homeAppId);
  return app ? { appId: app.id, title: app.title, icon: app.icon, color: app.color } : null;
}
