/**
 * Apps join the item tree (folder plan phase 3). Until now the Apps sidebar
 * kept its folders in one JSON document on the brain's profile
 * (`preferences.appNav`) and each login's pins and open counts in its own
 * preferences. Here they become what every other kind uses: folders are
 * `branch` rows under `apps`, an app's place is its `path`, and pins and
 * opens are `item_marks` rows.
 *
 * Both moves run once, lazily, the first time a brain's apps (or a login's
 * marks) are read, and are safe to repeat:
 * - `reconcileAppNav`: the document's folders become rows keeping their ids,
 *   names, looks and order; apps move into them. Names that clash in one
 *   folder get " 2", " 3"; a name with no letters or digits keeps its title
 *   and takes the slug `folder`. The document itself is left as it was, a
 *   copy to roll back to.
 * - `reconcileAppMarks`: one login's pins (in order) and open counts.
 * Done-markers live on the apps root row's data, so no preference key is
 * needed and no migration.
 */
import { sql } from 'drizzle-orm';
import { db, takeShareReadLock } from '@mantle/db';
import type { AppNavEntry, AppNavFolder } from '@mantle/client-types';
import { EMPTY_APP_NAV } from '@mantle/client-types/app-nav';
import { TREE_MAX_DEPTH } from '@mantle/client-types/tree';
import { slugifyFolder } from '@mantle/files';
import { loadProfilePreferences } from '../profile-preferences';
import { ranksAfter } from '../rank';
import { NodeOpRefusal, createNodeFolder, ensureKindRoot } from './node-ops';

const APPS_ROOT = 'apps';
/** A claim older than this is a crashed run; the next read takes over. */
const CLAIM_STALE_MS = 5 * 60_000;

type RootData = {
  appNavMigratedAt?: string;
  appNavMigratingAt?: string;
  appMarksMigrated?: string[];
};

async function rootData(ownerId: string): Promise<RootData> {
  const [row] = (await db.execute(sql`
    select data from nodes
     where owner_id = ${ownerId} and type = 'branch' and path = ${APPS_ROOT}::ltree`)) as unknown as Array<{
    data: RootData | null;
  }>;
  return row?.data ?? {};
}

/** Claim the layout move for this call; false when it is done or another
 *  call holds a fresh claim. */
async function claimAppNavMove(ownerId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const claimed = (await db.execute(sql`
    update nodes
       set data = coalesce(data, '{}'::jsonb)
                  || jsonb_build_object('appNavMigratingAt', ${new Date().toISOString()}::text)
     where owner_id = ${ownerId} and type = 'branch' and path = ${APPS_ROOT}::ltree
       and data->>'appNavMigratedAt' is null
       and (data->>'appNavMigratingAt' is null or data->>'appNavMigratingAt' < ${staleBefore})
     returning id`)) as unknown as unknown[];
  return claimed.length > 0;
}

async function markAppNavMoved(ownerId: string): Promise<void> {
  await db.execute(sql`
    update nodes
       set data = (coalesce(data, '{}'::jsonb) - 'appNavMigratingAt')
                  || jsonb_build_object('appNavMigratedAt', ${new Date().toISOString()}::text)
     where owner_id = ${ownerId} and type = 'branch' and path = ${APPS_ROOT}::ltree`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An existing apps folder with this id (a rerun after a crash), its path;
 *  '' when the id is taken by something else or is not a UUID at all. */
async function folderPathById(ownerId: string, id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return '';
  const [row] = (await db.execute(sql`
    select path::text as path, type, owner_id::text as owner from nodes
     where id = ${id}::uuid`)) as unknown as Array<{
    path: string;
    type: string;
    owner: string;
  }>;
  if (!row) return null;
  // Another owner's row, or not a folder under apps: take a fresh id.
  const ours = row.owner === ownerId && row.type === 'branch';
  return ours && row.path.startsWith(`${APPS_ROOT}.`) ? row.path : '';
}

/** Make one folder of the document, trying " 2", " 3"... when its name is
 *  taken in that folder. Returns the new folder's path. */
async function makeFolder(
  ownerId: string,
  parentPath: string,
  folder: AppNavFolder,
  rank: string,
): Promise<string> {
  const existing = await folderPathById(ownerId, folder.id);
  if (existing) return existing;
  const data: Record<string, unknown> = { rank };
  if (folder.icon) data.icon = folder.icon;
  if (folder.color) data.color = folder.color;
  // '' means the id belongs to some other node: the folder takes a fresh id.
  const id = existing === '' ? undefined : folder.id;
  const base = folder.name.trim() || 'Folder';
  const slugBase = slugifyFolder(base) ? undefined : 'folder';
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    const slug = slugBase ? (n === 1 ? slugBase : `${slugBase}-${n}`) : undefined;
    try {
      const made = await createNodeFolder(ownerId, parentPath, name, { id, data, slug });
      const [row] = (await db.execute(sql`
        select path::text as path from nodes where id = ${made}`)) as unknown as Array<{
        path: string;
      }>;
      return row!.path;
    } catch (err) {
      if (err instanceof NodeOpRefusal && err.code === 'conflict') continue;
      throw err;
    }
  }
  throw new Error(`app nav move: no free name for folder '${base}'`);
}

async function placeApps(ownerId: string, ids: readonly string[], path: string): Promise<void> {
  if (!ids.length) return;
  // The share lock (shared) before the rows: see takeShareReadLock.
  await db.transaction(async (tx) => {
    await takeShareReadLock(tx, ownerId);
    await tx.execute(sql`
      update nodes set path = ${path}::ltree
       where owner_id = ${ownerId} and type = 'app'
         and id in (${sql.join(
           ids.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})`);
  });
}

async function moveEntries(
  ownerId: string,
  entries: readonly AppNavEntry[],
  parentPath: string,
  depth: number,
): Promise<void> {
  const folders = entries.filter((e): e is AppNavFolder => e.kind === 'folder');
  const apps = entries.filter((e) => e.kind === 'app').map((e) => e.id);
  if (parentPath !== APPS_ROOT) await placeApps(ownerId, apps, parentPath);
  const ranks = ranksAfter(null, folders.length);
  for (const [i, folder] of folders.entries()) {
    if (depth >= TREE_MAX_DEPTH) {
      // Deeper than the tree allows (the document capped it too, so only a
      // hand-edited one): its apps join this folder, its own folders flatten.
      await moveEntries(ownerId, folder.children, parentPath, depth);
      continue;
    }
    const path = await makeFolder(ownerId, parentPath, folder, ranks[i]!);
    await moveEntries(ownerId, folder.children, path, depth + 1);
  }
}

/** Move the brain's app-nav document into folder rows, once. Returns whether
 *  this call did the move. */
export async function reconcileAppNav(ownerId: string): Promise<boolean> {
  await ensureKindRoot(ownerId, 'apps');
  if ((await rootData(ownerId)).appNavMigratedAt) return false;
  if (!(await claimAppNavMove(ownerId))) return false;
  // The anchor's own row holds the layout (a brain-level preference).
  const nav = (await loadProfilePreferences(ownerId)).appNav ?? EMPTY_APP_NAV;
  await moveEntries(ownerId, nav.entries, APPS_ROOT, 0);
  await markAppNavMoved(ownerId);
  return true;
}

/**
 * Copy one login's app pins (order kept) and open counts into item_marks,
 * once. Pins keep their order through staggered pinned_at; counts take the
 * larger of what is there and what was kept, so a repeat changes nothing.
 */
export async function reconcileAppMarks(ownerId: string, actorId: string): Promise<boolean> {
  await ensureKindRoot(ownerId, 'apps');
  if ((await rootData(ownerId)).appMarksMigrated?.includes(actorId)) return false;
  // Pins and opens are personal: the login's own row.
  const prefs = await loadProfilePreferences(actorId);
  const pins = prefs.appPins ?? [];
  const opens = Object.entries(prefs.appOpens ?? {});
  const ids = [...new Set([...pins, ...opens.map(([id]) => id)])];
  const live = ids.length
    ? new Set(
        (
          (await db.execute(sql`
            select id::text as id from nodes
             where owner_id = ${ownerId} and type = 'app'
               and id in (${sql.join(
                 ids.map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})`)) as unknown as Array<{ id: string }>
        ).map((r) => r.id),
      )
    : new Set<string>();
  const base = Date.now() - pins.length * 1000;
  for (const [i, id] of pins.entries()) {
    if (!live.has(id)) continue;
    const at = new Date(base + i * 1000).toISOString();
    await db.execute(sql`
      insert into item_marks (actor_id, node_id, pinned_at)
      values (${actorId}, ${id}, ${at}::timestamptz)
      on conflict (actor_id, node_id)
      do update set pinned_at = coalesce(item_marks.pinned_at, excluded.pinned_at)`);
  }
  for (const [id, stat] of opens) {
    if (!live.has(id)) continue;
    await db.execute(sql`
      insert into item_marks (actor_id, node_id, open_count, opened_at)
      values (${actorId}, ${id}, ${stat.n}, ${stat.at}::timestamptz)
      on conflict (actor_id, node_id)
      do update set open_count = greatest(item_marks.open_count, excluded.open_count),
                    opened_at = greatest(item_marks.opened_at, excluded.opened_at)`);
  }
  await db.execute(sql`
    update nodes
       set data = jsonb_set(
             coalesce(data, '{}'::jsonb), '{appMarksMigrated}',
             coalesce(data->'appMarksMigrated', '[]'::jsonb) || to_jsonb(${actorId}::text))
     where owner_id = ${ownerId} and type = 'branch' and path = ${APPS_ROOT}::ltree`);
  return true;
}
