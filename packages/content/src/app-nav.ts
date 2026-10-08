/**
 * App navigation, server side: the read older clients make (`loadAppNavView`,
 * GET /api/app-nav), per-login pins, and the open counter.
 *
 * Since folder plan phase 3 the apps live in the item tree like every other
 * kind (docs/folder-tree.md): folders are `branch` rows under `apps`, an
 * app's place is its `path`, and pins and opens are `item_marks` rows. The
 * old places (the brain's `preferences.appNav` document, each login's
 * `appPins` and `appOpens`) are read once by tree/apps-nav.ts and then left
 * alone. `loadAppNavView` answers in the old shape, built from the rows, so a
 * client from before the tree still draws the same sidebar; the layout is
 * changed through /api/tree now, never by saving a document.
 *
 * Every write NOTIFYs `app_nav_changed` with the anchor owner id, so each open
 * client refetches (realtime type 'app-nav'), on every device; tree writes to
 * apps do the same.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { apps, db, nodes } from '@mantle/db';
import type {
  AppNavEntry,
  AppNavFolder,
  AppNavItem,
  AppNavResponse,
  AppOpenStat,
} from '@mantle/client-types';
import { APP_PINS_MAX } from '@mantle/client-types/app-nav';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import { reconcileAppMarks, reconcileAppNav } from './tree/apps-nav';
import { recordItemOpened } from './tree/marks';
import { listTreeFolders } from './tree/read';
import { dataAccessOf } from './app-data-access';

/** NOTIFY channel for any app-nav write (payload: anchor owner id). Consumed
 *  by server/web/lib/realtime.ts, which broadcasts it as type 'app-nav'. */
export const APP_NAV_CHANGED_CHANNEL = 'app_nav_changed';

/** Tell every connected client the sidebar changed. Best-effort: a missed
 *  notify only delays the refresh until the next load. */
export async function notifyAppNavChanged(ownerId: string): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_notify(${APP_NAV_CHANGED_CHANNEL}, ${ownerId}::text)`);
  } catch (err) {
    console.error('[app-nav] notify failed:', err instanceof Error ? err.message : err);
  }
}

/** What an admin may do with an app's data: the owner db broker never
 *  refuses an admin's write. */
const ADMIN_DATA_ACCESS = dataAccessOf(true);

/** Every app the owner has, slim, for navigation. Unpaginated on purpose: the
 *  sidebar needs the whole set to place and search it. */
export async function listAppNavItems(ownerId: string): Promise<AppNavItem[]> {
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      data: nodes.data,
      tags: nodes.tags,
      updatedAt: nodes.updatedAt,
      manifest: apps.manifest,
      publishedBuild: apps.publishedBuild,
      draftBuild: apps.draftBuild,
      mcpAccess: apps.mcpAccess,
    })
    .from(nodes)
    .leftJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .orderBy(desc(nodes.updatedAt));
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      title: r.title,
      icon: projectAppIcon(d.icon) ?? null,
      color: projectAppTint(d.color) ?? null,
      tags: r.tags ?? [],
      description:
        typeof r.manifest?.description === 'string' && r.manifest.description
          ? r.manifest.description
          : null,
      // Previewable: a green published OR draft build, the same test the
      // frame-ticket route applies before it will render the app.
      hasBuild: r.publishedBuild?.ok === true || r.draftBuild?.ok === true,
      updatedAt: r.updatedAt.toISOString(),
      // The R and R/W pill (team apps Phase 3): the admin's own broker
      // writes every app, informational ones too (that flag binds members
      // and clients), so an admin's sidebar reads and writes.
      dataAccess: ADMIN_DATA_ACCESS,
      mcpAccess: r.mcpAccess === true,
    };
  });
}

/**
 * The sidebar in the old shape (AppNavResponse), built from the tree: each
 * folder lists its subfolders in their order, then its apps by name. Apps at
 * the top level are left out of `entries`, which older clients list after
 * the tree as unsorted. `rev` is a digest of the folders and where every app
 * sits, so it changes whenever the layout does, wherever it was changed.
 * `ownerId` is the anchor; `actorId` the login, for pins and counts.
 */
export async function loadAppNavView(ownerId: string, actorId: string): Promise<AppNavResponse> {
  await reconcileAppNav(ownerId);
  await reconcileAppMarks(ownerId, actorId);
  const [items, folders, marks] = await Promise.all([
    listAppNavItems(ownerId),
    listTreeFolders(ownerId, 'apps'),
    appMarks(ownerId, actorId),
  ]);
  const places = await appPlaces(ownerId);

  const byId = new Map<string, AppNavFolder>();
  const byPath = new Map<string, AppNavFolder>();
  const entries: AppNavEntry[] = [];
  for (const f of folders) {
    const entry: AppNavFolder = {
      kind: 'folder',
      id: f.id,
      name: f.name,
      ...(f.icon ? { icon: f.icon } : {}),
      ...(f.color ? { color: f.color } : {}),
      children: [],
    };
    byId.set(f.id, entry);
    byPath.set(f.path, entry);
    (f.parentId ? byId.get(f.parentId)?.children : entries)?.push(entry);
  }
  const titles = new Map(items.map((a) => [a.id, a.title.toLowerCase()]));
  const inFolders = places
    .filter((p) => byPath.has(p.path))
    .sort((a, b) => (titles.get(a.id) ?? '').localeCompare(titles.get(b.id) ?? ''));
  for (const p of inFolders) byPath.get(p.path)!.children.push({ kind: 'app', id: p.id });

  const digest = createHash('sha1')
    .update(JSON.stringify([folders.map((f) => [f.id, f.path, f.name, f.icon, f.color]), places]))
    .digest();
  return {
    nav: { rev: digest.readUInt32BE(0) & 0x7fffffff, entries },
    pins: marks.pins,
    opens: marks.opens,
    apps: items,
  };
}

/** Where every app sits, in a stable order (for the digest). */
async function appPlaces(ownerId: string): Promise<Array<{ id: string; path: string }>> {
  return (await db.execute(sql`
    select id::text as id, path::text as path from nodes
     where owner_id = ${ownerId} and type = 'app'
     order by id`)) as unknown as Array<{ id: string; path: string }>;
}

/** One login's app pins (in pin order) and open counts. */
async function appMarks(
  ownerId: string,
  actorId: string,
): Promise<{ pins: string[]; opens: Record<string, AppOpenStat> }> {
  const rows = (await db.execute(sql`
    select m.node_id::text as id, m.pinned_at, m.open_count, m.opened_at
      from item_marks m join nodes n on n.id = m.node_id
     where m.actor_id = ${actorId} and n.owner_id = ${ownerId} and n.type = 'app'
     order by m.pinned_at asc nulls last`)) as unknown as Array<{
    id: string;
    pinned_at: Date | string | null;
    open_count: number;
    opened_at: Date | string | null;
  }>;
  const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
  const opens: Record<string, AppOpenStat> = {};
  for (const r of rows) {
    if (r.open_count > 0 && r.opened_at) opens[r.id] = { n: r.open_count, at: iso(r.opened_at) };
  }
  return { pins: rows.filter((r) => r.pinned_at).map((r) => r.id), opens };
}

/** What PUT /api/app-nav answers now: the layout is the tree's. */
export const APP_NAV_LAYOUT_RETIRED =
  'Apps are organised as folders now; update the app to move or rename them.';

/** Replace one login's pins, in order (the old PUT /api/app-nav/pins):
 *  apps named are pinned in that order, every other app unpinned. Pins of
 *  missing apps are dropped. */
export async function saveAppPins(
  ownerId: string,
  actorId: string,
  pins: string[],
): Promise<string[]> {
  await reconcileAppMarks(ownerId, actorId);
  const live = new Set((await listAppNavItems(ownerId)).map((a) => a.id));
  const wanted = [...new Set(pins.map((id) => id.trim().toLowerCase()))]
    .filter((id) => live.has(id))
    .slice(0, APP_PINS_MAX);
  await db.execute(sql`
    update item_marks m set pinned_at = null
      from nodes n
     where n.id = m.node_id and m.actor_id = ${actorId}
       and n.owner_id = ${ownerId} and n.type = 'app' and m.pinned_at is not null`);
  const base = Date.now() - wanted.length * 1000;
  for (const [i, id] of wanted.entries()) {
    const at = new Date(base + i * 1000).toISOString();
    await db.execute(sql`
      insert into item_marks (actor_id, node_id, pinned_at)
      values (${actorId}, ${id}, ${at}::timestamptz)
      on conflict (actor_id, node_id) do update set pinned_at = excluded.pinned_at`);
  }
  void notifyAppNavChanged(ownerId);
  return wanted;
}

/** Count one open of an app by one login. False when the app doesn't exist. */
export async function recordAppOpen(
  ownerId: string,
  actorId: string,
  appId: string,
): Promise<boolean> {
  const [app] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, appId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .limit(1);
  if (!app) return false;
  await reconcileAppMarks(ownerId, actorId);
  return recordItemOpened(ownerId, actorId, app.id);
}
