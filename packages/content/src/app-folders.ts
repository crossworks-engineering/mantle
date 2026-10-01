/**
 * Where a reader's apps sit: the Apps folders a member or a client login
 * sees in its launcher (GET /api/member/apps, /api/client/apps), read only.
 *
 * The rule is the list's own. The caller passes the apps the reader may RUN
 * (`listMemberAppsPlaced`, `listClientAppsPlaced`: the level rule and the
 * green published build), and a folder is answered only when it is on the
 * way to one of them. So a folder that holds nothing the reader may run is
 * never named, whatever its share says: an empty shared folder, a folder of
 * drafts and a folder of admin apps are all absent. Nothing is stored and
 * nothing is read below those paths.
 *
 * Folder rows are the brain's (a shared folder's own row is not the
 * reader's to read: it inherits only from above itself), so call this on
 * the admin pool, outside any viewer scope, as the reader trees are
 * (./tree/reader.ts).
 */
import { sql } from 'drizzle-orm';
import { currentSpaceScope, currentViewerLevel, db } from '@mantle/db';
import type { AppLauncherFolder } from '@mantle/client-types';
import { TREE_KIND_SPECS } from '@mantle/client-types/tree';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import { treeFolderChain } from '@mantle/content-core/tree';

/** An app the reader may run, and the path of the folder it sits in. */
export type AppPlace = { id: string; path: string };

/** A folder row of the Apps tree, as the build below needs it. */
export type AppFolderRow = {
  id: string;
  path: string;
  title: string;
  data: Record<string, unknown> | null;
};

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

/**
 * The launcher folders for the apps a reader may run. Only the rows on the
 * way to those apps are read, in the folder order (manual rank, then name).
 */
export async function appLauncherFolders(
  anchorId: string,
  places: readonly AppPlace[],
): Promise<AppLauncherFolder[]> {
  if (currentViewerLevel() !== 'admin' || currentSpaceScope()) {
    throw new Error('app folders called inside a viewer scope: call it on the admin pool');
  }
  const wanted = [...new Set(places.flatMap((p) => chainOf(p.path)))];
  if (!wanted.length) return [];
  const rows = (await db.execute(sql`
    select f.id, f.path::text as path, f.title, f.data
      from nodes f
     where f.owner_id = ${anchorId} and f.type = 'branch'
       and f.path::text in (${sql.join(
         wanted.map((w) => sql`${w}`),
         sql`, `,
       )})
     order by f.data->>'rank' collate "C" nulls last, lower(f.title), f.id`)) as unknown as AppFolderRow[];
  return buildAppLauncherFolders(rows, places);
}
