/**
 * Apps for clients (client logins C6, docs/client-logins.md section 10). A
 * client RUNS apps; a client never creates, edits, builds, publishes, shares
 * or deletes one. What a client may run: an app at CLIENT level exactly, with
 * a green PUBLISHED build. Never a draft, and never a team, admin or public
 * app (decision 3: a public app is for anonymous visitors on its link, not
 * for the client portal).
 *
 * The rule is written in every query here (`CLIENT_APP_LEVELS`, the published
 * build), not left to row security alone: the db broker runs the app's SQLite
 * on the admin pool (the registry rows it writes are admin), and row security
 * does not reach SQLite. The client routes still read through
 * `withViewer('client', …)` as a second lock.
 *
 * Only granted columns are read (never `apps.draft_*`), so these work on the
 * client role.
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { apps, asViewerLevel, db, nodes, type AppManifest, type BuildRef } from '@mantle/db';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import type { AppTint, ClientAppCard } from '@mantle/client-types';
import type { AppPlace } from './app-folders';
import { isReadAt, readAtSql } from './item-level';
import { dataAccessOf } from './app-data-access';

/** An app is used, not only read (run, tools, its database): an embed in a
 *  shared item opens READING only, so an app named by an embed stays at its
 *  own level and folder share here (migration 0208, review F5). */
const APP_READ = { embeds: false } as const;

/** The app levels a client may run: client, and nothing else. */
export const CLIENT_APP_LEVELS = ['client'] as const;

export function isClientAppLevel(level: unknown): boolean {
  return (CLIENT_APP_LEVELS as readonly string[]).includes(asViewerLevel(level));
}

/** One launcher card: the published contract type. */
export type { ClientAppCard };

/** A runnable app: what the frame and the brokers need, published only. */
export type ClientRunnableApp = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  manifest: AppManifest;
  publishedBuild: BuildRef;
  /** apps.data_read_only: the app is informational, a client only reads. */
  dataReadOnly: boolean;
};

const publishedGreen = sql`(${apps.publishedBuild}->>'ok')::boolean is true`;

function runnableWhere(anchorId: string) {
  return and(
    eq(nodes.ownerId, anchorId),
    eq(nodes.type, 'app'),
    // At client by its own level or through a folder shared with clients.
    readAtSql(CLIENT_APP_LEVELS, APP_READ),
    // Never a public app, even in a client-shared folder (access matrix
    // audit, M2): it is read at public, anyone with its link, so a client's
    // write would show to anonymous visitors. Clients run client apps only.
    ne(nodes.audience, 'public'),
    publishedGreen,
  );
}

/** The apps a client may run, by title. No level and no author. */
export async function listClientApps(anchorId: string): Promise<ClientAppCard[]> {
  return (await listClientAppsPlaced(anchorId)).apps;
}

/** The same list, with the folder path of each app: what the launcher's
 *  folders are built from (./app-folders.ts). The paths stay on the brain. */
export async function listClientAppsPlaced(
  anchorId: string,
): Promise<{ apps: ClientAppCard[]; places: AppPlace[] }> {
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      path: sql<string>`${nodes.path}::text`,
      data: nodes.data,
      audience: nodes.audience,
      inheritedLevel: nodes.inheritedLevel,
      updatedAt: nodes.updatedAt,
      manifest: apps.manifest,
      dataReadOnly: apps.dataReadOnly,
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(runnableWhere(anchorId))
    .orderBy(asc(nodes.title))
    .limit(500);
  const places: AppPlace[] = [];
  const cards = rows.flatMap((r): ClientAppCard[] => {
    // The query already keeps to client level; a row outside it is never a
    // card, whatever the column holds.
    if (!isReadAt(r.audience, r.inheritedLevel, CLIENT_APP_LEVELS)) return [];
    places.push({ id: r.id, path: r.path });
    const d = (r.data ?? {}) as Record<string, unknown>;
    const description = (r.manifest as AppManifest | null)?.description;
    return [
      {
        id: r.id,
        title: r.title,
        icon: projectAppIcon(d.icon) ?? null,
        color: projectAppTint(d.color) ?? null,
        description: typeof description === 'string' && description.trim() ? description : null,
        updatedAt: r.updatedAt.toISOString(),
        dataReadOnly: r.dataReadOnly === true,
        // The client broker's rule: a client app is written unless
        // informational.
        dataAccess: dataAccessOf(r.dataReadOnly !== true),
      },
    ];
  });
  return { apps: cards, places };
}

/** One app a client may run, or null: not an app, not at client level, no
 *  green published build, or not this brain's. The same null for all of
 *  them, so no answer tells a team app from a missing one. */
export async function getClientRunnableApp(
  anchorId: string,
  appId: string,
): Promise<ClientRunnableApp | null> {
  const [row] = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      data: nodes.data,
      audience: nodes.audience,
      inheritedLevel: nodes.inheritedLevel,
      manifest: apps.manifest,
      publishedBuild: apps.publishedBuild,
      dataReadOnly: apps.dataReadOnly,
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.id, appId), runnableWhere(anchorId)))
    .limit(1);
  if (!row?.publishedBuild?.ok || !isReadAt(row.audience, row.inheritedLevel, CLIENT_APP_LEVELS)) {
    return null;
  }
  const d = (row.data ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    title: row.title,
    icon: projectAppIcon(d.icon) ?? null,
    color: projectAppTint(d.color) ?? null,
    manifest: (row.manifest ?? {}) as AppManifest,
    publishedBuild: row.publishedBuild,
    dataReadOnly: row.dataReadOnly === true,
  };
}
