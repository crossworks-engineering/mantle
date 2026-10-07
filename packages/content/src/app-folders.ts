/**
 * The Apps launcher of a member or a client login (GET /api/member/apps,
 * /api/client/apps): the apps the reader may RUN, and the admin's Apps
 * folders those apps sit in, read only.
 *
 * The rule is the list's own. The apps are read as the reader
 * (`listMemberAppsPlaced`, `listClientAppsPlaced`: the level rule and the
 * green published build, inside `withViewer`), and a folder is answered only
 * when it is on the way to one of them. So a folder that holds nothing the
 * reader may run is never named, whatever its share says: an empty shared
 * folder, a folder of drafts and a folder of admin apps are all absent.
 * Nothing is stored and nothing is read below those paths.
 *
 * Folder rows are the brain's (a shared folder's own row is not the
 * reader's to read: it inherits only from above itself), so they are read
 * on the admin pool. That read takes no paths from a caller: `appLauncher`
 * reads the reader's apps itself and looks up the folders on their paths
 * only, as the reader trees do (./tree/reader.ts, `visibleFolders`). Call it
 * on the admin pool, outside any viewer scope.
 */
import { sql } from 'drizzle-orm';
import { currentSpaceScope, currentViewerLevel, db, withViewer } from '@mantle/db';
import type { AppLauncherFolder, ClientAppCard, MemberAppCard } from '@mantle/client-types';
import { TREE_KIND_SPECS } from '@mantle/client-types/tree';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import { treeFolderChain } from '@mantle/content-core/tree';
import { listClientAppsPlaced } from './client-apps';
import { listMemberAppsPlaced } from './member-apps';

/** An app the reader may run, and the path of the folder it sits in. */
export type AppPlace = { id: string; path: string };

/** A folder row of the Apps tree, as the build below needs it. */
export type AppFolderRow = {
  id: string;
  path: string;
  title: string;
  data: Record<string, unknown> | null;
};

/** Who opens the launcher: a member login reads at team, a client login at
 *  client. */
export type AppLauncherReader = 'team' | 'client';

const APPS_ROOT = TREE_KIND_SPECS.apps.root;

/** The folder paths that lead to `path`, top down; none for the root or for
 *  a path outside the Apps tree. */
function chainOf(path: string): string[] {
  return path.startsWith(`${APPS_ROOT}.`) ? treeFolderChain(path) : [];
}

/**
 * The folders that lead to `places`, from their rows (in the order given:
 * siblings keep it). An app sits in the deepest folder of its path whose
 * whole chain has rows; a path with no row at its top leaves the app at the
 * top level. A row that leads to no app is dropped.
 */
export function buildAppLauncherFolders(
  rows: readonly AppFolderRow[],
  places: readonly AppPlace[],
): AppLauncherFolder[] {
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const appIds = new Map<string, string[]>();
  const parentOf = new Map<string, string | null>();
  for (const place of places) {
    let parent: AppFolderRow | null = null;
    for (const p of chainOf(place.path)) {
      const row = byPath.get(p);
      if (!row) break;
      parentOf.set(row.id, parent?.id ?? null);
      parent = row;
    }
    if (parent) appIds.set(parent.id, [...(appIds.get(parent.id) ?? []), place.id]);
  }
  return rows.flatMap((r): AppLauncherFolder[] => {
    if (!parentOf.has(r.id)) return [];
    const data = r.data ?? {};
    return [
      {
        id: r.id,
        name: r.title,
        icon: projectAppIcon(data.icon) ?? null,
        color: projectAppTint(data.color) ?? null,
        parentId: parentOf.get(r.id) ?? null,
        appIds: appIds.get(r.id) ?? [],
      },
    ];
  });
}

/** The brain's folder rows on the way to `places`, in the folder order
 *  (manual rank, then name). Private to this module: the places are always
 *  the ones the reader's own list gave. */
async function folderRowsFor(
  anchorId: string,
  places: readonly AppPlace[],
): Promise<AppFolderRow[]> {
  const wanted = [...new Set(places.flatMap((p) => chainOf(p.path)))];
  if (!wanted.length) return [];
  // An ltree label holds no comma, brace or quote, so the array literal
  // needs no quoting (as ./tree/member-tree.ts builds it); one bound value,
  // compared as ltree so the (owner, path) branch index serves.
  return (await db.execute(sql`
    select f.id, f.path::text as path, f.title, f.data
      from nodes f
     where f.owner_id = ${anchorId} and f.type = 'branch'
       and f.path = any(${`{${wanted.join(',')}}`}::ltree[])
     order by f.data->>'rank' collate "C" nulls last, lower(f.title), f.id`)) as unknown as AppFolderRow[];
}

/**
 * The launcher of one reader: its apps, by title, and the folders that lead
 * to them. The apps are read as the reader; the folders as the brain, from
 * those apps' paths alone. A failed folder read never hides the apps: the
 * launcher then answers no folders (one flat list) and the failure is
 * logged.
 */
export function appLauncher(
  anchorId: string,
  reader: 'team',
): Promise<{ apps: MemberAppCard[]; folders: AppLauncherFolder[] }>;
export function appLauncher(
  anchorId: string,
  reader: 'client',
): Promise<{ apps: ClientAppCard[]; folders: AppLauncherFolder[] }>;
export async function appLauncher(
  anchorId: string,
  reader: AppLauncherReader,
): Promise<{ apps: Array<MemberAppCard | ClientAppCard>; folders: AppLauncherFolder[] }> {
  if (currentViewerLevel() !== 'admin' || currentSpaceScope()) {
    throw new Error('app launcher called inside a viewer scope: call it on the admin pool');
  }
  const { apps, places }: { apps: Array<MemberAppCard | ClientAppCard>; places: AppPlace[] } =
    reader === 'team'
      ? await withViewer('team', () => listMemberAppsPlaced(anchorId))
      : await withViewer('client', () => listClientAppsPlaced(anchorId));
  let folders: AppLauncherFolder[] = [];
  try {
    folders = buildAppLauncherFolders(await folderRowsFor(anchorId, places), places);
  } catch (err) {
    console.error(
      '[app-folders] the launcher folders could not be read:',
      err instanceof Error ? err.message : err,
    );
  }
  return { apps, folders };
}
