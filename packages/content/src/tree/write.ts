/**
 * The item tree's writes: create, rename, restyle, move and reorder folders,
 * delete a folder (its contents move up to the parent), and move items.
 *
 * What differs by kind lives in one small ops table. Files are the one kind
 * whose folders are real directories, so their ops are the Files package's
 * disk-safe operations (disk first, then the database, rolled back together);
 * every other kind's folders are rows only (./node-ops). The look and the
 * order are plain row data for every kind.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, isCheckViolation, nodes, takeShareWriteLock } from '@mantle/db';
import {
  createFolder as createFilesFolder,
  deleteFolder as deleteFilesFolder,
  moveFileById,
  moveFolderById,
  renameFolderById,
  strayFilesIn,
} from '@mantle/files';
import type { AppTint } from '@mantle/client-types/app-nav';
import {
  TREE_FOLDER_NAME_MAX,
  TREE_KIND_SPECS,
  TREE_SHARE_LEVELS,
  type TreeFolder,
  type TreeKind,
  type TreeShareLevel,
} from '@mantle/client-types/tree';
import { treeParentPath } from '@mantle/content-core/tree';
import { ranksAfter } from '../rank';
import { isTreeLiveKind } from './kinds';
import {
  TreeVisibilityError,
  liftDiff,
  moveFolderDiff,
  moveItemsDiff,
  shareDiff,
  type VisibilityDiff,
  withEmbedsGoingDown,
} from './visibility';
import { itemLevel } from '../item-level';
import { lowerEmbedClosure } from '../embed-closure';
import { refoldPageTexts } from '../pages/level-text';
import {
  NodeOpRefusal,
  createNodeFolder,
  moveNodeFolder,
  moveNodeItem,
  removeEmptyNodeFolder,
  renameNodeFolder,
} from './node-ops';
import { treeFolderById } from './read';

/** NOTIFY channel for a tree write (payload: JSON {ownerId, kind}). Consumed
 *  by server/web/lib/realtime.ts, which broadcasts it as type 'tree'. */
export const TREE_CHANGED_CHANNEL = 'tree_changed';

/** Tell every open client that a kind's tree changed. Best-effort: a missed
 *  notify only delays the refresh. Item uploads and deletes already raise
 *  their own node events. */
export async function notifyTreeChanged(ownerId: string, kind: TreeKind): Promise<void> {
  try {
    await db.execute(
      sql`SELECT pg_notify(${TREE_CHANGED_CHANNEL}, ${JSON.stringify({ ownerId, kind })})`,
    );
    // A client from before the tree draws Apps from /api/app-nav and refetches
    // on this (app-nav.ts APP_NAV_CHANGED_CHANNEL; named here to keep the
    // tree module free of the app-nav one).
    if (kind === 'apps')
      await db.execute(sql`SELECT pg_notify('app_nav_changed', ${ownerId}::text)`);
  } catch (err) {
    console.error('[tree] notify failed:', err instanceof Error ? err.message : err);
  }
}

/** A refusal the caller can show: `not-found` (404), `conflict` (409),
 *  `invalid` (400). */
export class TreeError extends Error {
  constructor(
    readonly code: 'not-found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'TreeError';
  }
}

/** The per-kind half of a write. Paths are ltree strings. */
type TreeKindOps = {
  /** Returns the new folder's id. */
  createFolder(ownerId: string, parentPath: string, name: string): Promise<string>;
  renameFolder(ownerId: string, folderId: string, name: string): Promise<void>;
  moveFolder(ownerId: string, folderId: string, destParentPath: string): Promise<void>;
  moveItem(ownerId: string, itemId: string, destPath: string): Promise<void>;
  /** Remove a folder that no longer holds anything. */
  removeEmptyFolder(ownerId: string, folderId: string): Promise<void>;
};

const FILES_OPS: TreeKindOps = {
  async createFolder(ownerId, parentPath, name) {
    return (await createFilesFolder({ ownerId, parentPath, slug: name, name })).id;
  },
  async renameFolder(ownerId, folderId, name) {
    await renameFolderById({ ownerId, folderId, newSlug: name });
  },
  async moveFolder(ownerId, folderId, destParentPath) {
    await moveFolderById({ ownerId, folderId, destParentPath });
  },
  async moveItem(ownerId, itemId, destPath) {
    await moveFileById({ ownerId, fileId: itemId, destPath });
  },
  async removeEmptyFolder(ownerId, folderId) {
    const res = await deleteFilesFolder({ ownerId, folderId });
    if (!res.ok) throw new TreeError('conflict', res.reason);
  },
};

/** Every kind but Files: folders and locations are rows only. */
function nodeOps(kind: TreeKind): TreeKindOps {
  return {
    createFolder: createNodeFolder,
    renameFolder: renameNodeFolder,
    moveFolder: moveNodeFolder,
    moveItem: (ownerId, itemId, destPath) => moveNodeItem(ownerId, kind, itemId, destPath),
    removeEmptyFolder: removeEmptyNodeFolder,
  };
}

function opsFor(kind: TreeKind): TreeKindOps {
  if (!isTreeLiveKind(kind)) throw new TreeError('invalid', `the ${kind} tree is not served yet`);
  return kind === 'files' ? FILES_OPS : nodeOps(kind);
}

/** A Files op throws plain errors whose message is written for people
 *  (a clash, a depth refusal): pass them on as refusals. */
async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof TreeError) throw err;
    if (err instanceof NodeOpRefusal) throw new TreeError(err.code, err.message);
    const message = err instanceof Error ? err.message : String(err);
    throw new TreeError(/already exists|unique/i.test(message) ? 'conflict' : 'invalid', message);
  }
}

async function folderOrThrow(
  ownerId: string,
  kind: TreeKind,
  folderId: string,
): Promise<TreeFolder> {
  const folder = await treeFolderById(ownerId, kind, folderId);
  if (!folder) throw new TreeError('not-found', 'folder not found');
  return folder;
}

/** The path a folder id stands for; null (or no id) is the kind's root. */
async function pathOf(ownerId: string, kind: TreeKind, folderId: string | null): Promise<string> {
  return folderId
    ? (await folderOrThrow(ownerId, kind, folderId)).path
    : TREE_KIND_SPECS[kind].root;
}

function cleanName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, TREE_FOLDER_NAME_MAX);
  if (!clean) throw new TreeError('invalid', 'a folder needs a name');
  return clean;
}

async function folderAt(ownerId: string, path: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'branch'), sql`${nodes.path}::text = ${path}`),
    )
    .limit(1);
  return row ?? null;
}

/** Create a folder under `parentId` (null = the top level). */
export async function createTreeFolder(
  ownerId: string,
  kind: TreeKind,
  args: { parentId: string | null; name: string },
): Promise<TreeFolder> {
  const ops = opsFor(kind);
  const parentPath = await pathOf(ownerId, kind, args.parentId);
  const name = cleanName(args.name);
  const id = await refusing(() => ops.createFolder(ownerId, parentPath, name));
  return folderOrThrow(ownerId, kind, id);
}

export type TreeFolderPatch = {
  name?: string;
  icon?: string | null;
  color?: AppTint | null;
  /** Move under another folder; null = the top level. */
  parentId?: string | null;
  /** Reorder among its siblings: directly after this sibling; null = first. */
  after?: string | null;
  /** Share the folder, and everything in it now and later, with the team or
   *  clients; null stops sharing it (folder plan phase 4). */
  share?: TreeShareLevel | null;
};

/** How a write that changes who can see items goes ahead: refused with the
 *  list of changes (TreeVisibilityError) unless `confirm` is set. */
export type TreeWriteOpts = {
  confirm?: boolean;
  /** With `confirm`: how many changes the caller was shown. When the change
   *  now differs (an agent or another admin filed or shared something while
   *  the dialog was open), it is refused again with the new list instead of
   *  going ahead unseen. Left out, `confirm` alone goes ahead. */
  seen?: number;
};

async function checkVisibility(
  ownerId: string,
  diff: Promise<VisibilityDiff>,
  opts: TreeWriteOpts,
): Promise<VisibilityDiff> {
  const d = await diff;
  const refused =
    (d.total > 0 && !opts.confirm) ||
    (opts.confirm && opts.seen !== undefined && d.total !== opts.seen);
  if (refused) throw new TreeVisibilityError(await withEmbedsGoingDown(ownerId, d));
  return d;
}

/**
 * After a write changed where items sit relative to shared folders: embeds
 * follow each page, drawing and note to the level it is now read at (never
 * raising anything), and the indexed text of the pages concerned is folded
 * for that level (pages/level-text.ts). `scope` is a subtree path, or ids.
 */
async function followShares(
  ownerId: string,
  scope: { path: string } | { ids: readonly string[] },
): Promise<void> {
  const where =
    'path' in scope
      ? sql`path <@ ${scope.path}::ltree`
      : scope.ids.length
        ? sql`id in (${sql.join(
            scope.ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`false`;
  const rows = (await db.execute(sql`
    select id::text as id, type::text as type, audience, inherited_level from nodes
     where owner_id = ${ownerId} and type in ('page', 'draw', 'note') and ${where}`)) as unknown as Array<{
    id: string;
    type: string;
    audience: string;
    inherited_level: string | null;
  }>;
  for (const r of rows) {
    const level = itemLevel(r.audience, r.inherited_level);
    if (level !== 'admin') await lowerEmbedClosure(ownerId, r.id, level);
  }
  const pageIds = rows.filter((r) => r.type === 'page').map((r) => r.id);
  if (pageIds.length) await refoldPageTexts(ownerId, pageIds);
}

/** Apply one or more changes to a folder, in a fixed order: move, rename,
 *  look, then place. Returns the folder as it now is. */
export async function updateTreeFolder(
  ownerId: string,
  kind: TreeKind,
  folderId: string,
  patch: TreeFolderPatch,
  opts: TreeWriteOpts = {},
): Promise<TreeFolder> {
  const ops = opsFor(kind);
  const folder = await folderOrThrow(ownerId, kind, folderId);
  // A share in the patch is checked before anything else is written: its
  // refusal (not shareable, or a confirmation needed) writes nothing.
  if (patch.share !== undefined && (folder.share ?? null) !== patch.share) {
    assertShareable(kind, folder, patch.share);
    if (!opts.confirm) {
      await checkVisibility(ownerId, shareDiff(ownerId, folder, patch.share), opts);
    }
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === folderId) throw new TreeError('invalid', 'a folder cannot hold itself');
    if (folder.system && patch.parentId !== folder.parentId) {
      throw new TreeError('invalid', 'this folder is made by Mantle; it stays where it is');
    }
    const dest = await pathOf(ownerId, kind, patch.parentId);
    if (dest !== treeParentPath(folder.path)) {
      const diff = await checkVisibility(ownerId, moveFolderDiff(ownerId, folder, dest), opts);
      await refusing(() => ops.moveFolder(ownerId, folderId, dest));
      if (diff.total > 0) {
        const moved = await folderOrThrow(ownerId, kind, folderId);
        await followShares(ownerId, { path: moved.path });
      }
    }
  }
  if (patch.name !== undefined) {
    if (folder.system)
      throw new TreeError('invalid', 'this folder is made by Mantle; its name is fixed');
    await refusing(() => ops.renameFolder(ownerId, folderId, cleanName(patch.name!)));
  }
  if (patch.icon !== undefined || patch.color !== undefined) {
    await setFolderLook(ownerId, folderId, { icon: patch.icon, color: patch.color });
  }
  if (patch.after !== undefined) {
    await placeFolder(ownerId, kind, folderId, patch.after);
  }
  if (patch.share !== undefined) {
    await setFolderShare(
      ownerId,
      kind,
      await folderOrThrow(ownerId, kind, folderId),
      patch.share,
      opts,
    );
  }
  return folderOrThrow(ownerId, kind, folderId);
}

/** Refuse a share this kind, level or folder may not take (stopping a share
 *  is always allowed). */
function assertShareable(kind: TreeKind, folder: TreeFolder, share: TreeShareLevel | null): void {
  if (share === null) return;
  const spec = TREE_KIND_SPECS[kind];
  if (!spec.shareable) {
    throw new TreeError('invalid', `${kind} folders stay with admins; they cannot be shared`);
  }
  if (!(spec.shareLevels ?? TREE_SHARE_LEVELS).includes(share)) {
    throw new TreeError(
      'invalid',
      `a ${kind} folder can only be shared with the ${(spec.shareLevels ?? TREE_SHARE_LEVELS).join(' or ')}`,
    );
  }
  if (folder.system) {
    throw new TreeError('invalid', 'this folder is made by Mantle and stays with admins');
  }
}

/** Share a folder (and everything below it) at `share`, or stop sharing it. */
async function setFolderShare(
  ownerId: string,
  kind: TreeKind,
  folder: TreeFolder,
  share: TreeShareLevel | null,
  opts: TreeWriteOpts,
): Promise<void> {
  assertShareable(kind, folder, share);
  if ((folder.share ?? null) === share) return;
  const diff = await checkVisibility(ownerId, shareDiff(ownerId, folder, share), opts);
  // The database refreshes everything below (migration 0204 triggers). Its
  // share check is the last word on which roots may share: a refusal there
  // is a refusal, not a server error.
  try {
    await db.transaction(async (tx) => {
      await takeShareWriteLock(tx, ownerId);
      await tx
        .update(nodes)
        .set({ shareLevel: share, updatedAt: new Date() })
        .where(and(eq(nodes.id, folder.id), eq(nodes.ownerId, ownerId)));
    });
  } catch (err) {
    if (isCheckViolation(err)) {
      throw new TreeError('invalid', `${kind} folders cannot be shared on this brain yet`);
    }
    throw err;
  }
  if (diff.total > 0) await followShares(ownerId, { path: folder.path });
}

async function setFolderLook(
  ownerId: string,
  folderId: string,
  look: { icon?: string | null; color?: AppTint | null },
): Promise<void> {
  const [row] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.id, folderId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  const data = { ...((row?.data ?? {}) as Record<string, unknown>) };
  for (const key of ['icon', 'color'] as const) {
    const value = look[key];
    if (value === undefined) continue;
    if (value === null || value === '') delete data[key];
    else data[key] = value;
  }
  await db
    .update(nodes)
    .set({ data, updatedAt: new Date() })
    .where(and(eq(nodes.id, folderId), eq(nodes.ownerId, ownerId)));
}

/** The direct subfolders of `parentPath` in their current order. */
async function childFolderIds(
  ownerId: string,
  parentPath: string,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const rows = (await db.execute(sql`
    select id, data from nodes
     where owner_id = ${ownerId} and type = 'branch'
       and path ~ ${`${parentPath}.*{1}`}::lquery
     order by data->>'rank' collate "C" nulls last, lower(title), id`)) as unknown as Array<{
    id: string;
    data: Record<string, unknown> | null;
  }>;
  return rows.map((r) => ({ id: r.id, data: r.data ?? {} }));
}

/**
 * Put a folder directly after `afterId` among its siblings (null = first).
 * The whole sibling list is re-ranked in its new order: a level holds a
 * handful of folders, and fresh ranks never collide with older ones.
 */
async function placeFolder(
  ownerId: string,
  kind: TreeKind,
  folderId: string,
  afterId: string | null,
): Promise<void> {
  const folder = await folderOrThrow(ownerId, kind, folderId);
  const siblings = (await childFolderIds(ownerId, treeParentPath(folder.path))).filter(
    (s) => s.id !== folderId,
  );
  const at = afterId === null ? 0 : siblings.findIndex((s) => s.id === afterId) + 1;
  if (afterId !== null && at === 0)
    throw new TreeError('invalid', 'the sibling to place after was not found');
  const moving = { id: folderId, data: {} as Record<string, unknown> };
  const order = [...siblings.slice(0, at), moving, ...siblings.slice(at)];
  const ranks = ranksAfter(null, order.length);
  await db.transaction(async (tx) => {
    for (const [i, s] of order.entries()) {
      await tx.execute(sql`
        update nodes set data = jsonb_set(coalesce(data, '{}'::jsonb), '{rank}', to_jsonb(${ranks[i]!}::text))
         where id = ${s.id} and owner_id = ${ownerId}`);
    }
  });
}

/**
 * Delete a folder; what it holds moves up to its parent first. Refused before
 * anything moves when the parent already has a folder or an item of the same
 * name, so a delete never merges or renames silently.
 */
export async function deleteTreeFolder(
  ownerId: string,
  kind: TreeKind,
  folderId: string,
  opts: TreeWriteOpts = {},
): Promise<void> {
  const ops = opsFor(kind);
  const folder = await folderOrThrow(ownerId, kind, folderId);
  if (folder.system) {
    throw new TreeError('invalid', 'this folder is made by Mantle; it cannot be deleted');
  }
  const diff = await checkVisibility(ownerId, liftDiff(ownerId, folder), opts);
  const affected = diff.total
    ? (
        (await db.execute(sql`
          select id::text as id from nodes
           where owner_id = ${ownerId} and path <@ ${folder.path}::ltree and id <> ${folderId}`)) as unknown as Array<{
          id: string;
        }>
      ).map((r) => r.id)
    : [];
  const parentPath = treeParentPath(folder.path);
  const spec = TREE_KIND_SPECS[kind];
  const [children, items] = await Promise.all([
    db.execute(sql`
      select id, path::text as path, title from nodes
       where owner_id = ${ownerId} and type = 'branch'
         and path ~ ${`${folder.path}.*{1}`}::lquery`) as unknown as Promise<
      Array<{ id: string; path: string; title: string }>
    >,
    db.execute(sql`
      select id, title, lower(coalesce(data->>'filename', title)) as name from nodes
       where owner_id = ${ownerId} and type = ${spec.nodeType}
         and path = ${folder.path}::ltree`) as unknown as Promise<
      Array<{ id: string; title: string; name: string }>
    >,
  ]);
  const clashes: string[] = [];
  for (const c of children) {
    const label = c.path.split('.').at(-1)!;
    if (await folderAt(ownerId, `${parentPath}.${label}`)) clashes.push(c.title);
  }
  if (kind === 'files' && items.length) {
    const taken = (await db.execute(sql`
      select lower(data->>'filename') as name from nodes
       where owner_id = ${ownerId} and type = 'file' and path = ${parentPath}::ltree`)) as unknown as Array<{
      name: string;
    }>;
    const names = new Set(taken.map((t) => t.name));
    for (const i of items) if (names.has(i.name)) clashes.push(i.title);
  }
  // Files: a file on disk the brain does not track would stop the final
  // delete after everything else moved up; refuse now, before anything moves.
  if (kind === 'files') {
    const stray = await strayFilesIn(folder.path, new Set(items.map((i) => i.name)));
    if (stray.length) {
      throw new TreeError(
        'conflict',
        `the folder holds file(s) on disk the brain does not track (${stray.join(', ')}); move or delete them first`,
      );
    }
  }
  if (clashes.length) {
    throw new TreeError(
      'conflict',
      `the folder above already has ${clashes.length === 1 ? 'something' : 'things'} named ${clashes
        .slice(0, 5)
        .map((c) => `'${c}'`)
        .join(', ')}; rename or move ${clashes.length === 1 ? 'it' : 'them'} first`,
    );
  }
  for (const c of children) await refusing(() => ops.moveFolder(ownerId, c.id, parentPath));
  for (const i of items) await refusing(() => ops.moveItem(ownerId, i.id, parentPath));
  await ops.removeEmptyFolder(ownerId, folderId);
  if (affected.length) await followShares(ownerId, { ids: affected });
}

export type TreeMoveResult = {
  moved: number;
  failed: Array<{ id: string; error: string }>;
};

/** Move items into a folder (null = the kind's root, unsorted). Each item
 *  moves on its own; one that cannot is reported, the rest still move. */
export async function moveTreeItems(
  ownerId: string,
  kind: TreeKind,
  itemIds: readonly string[],
  folderId: string | null,
  opts: TreeWriteOpts = {},
): Promise<TreeMoveResult> {
  const ops = opsFor(kind);
  const dest = await pathOf(ownerId, kind, folderId);
  const ids = [...new Set(itemIds)];
  const diff = await checkVisibility(ownerId, moveItemsDiff(ownerId, kind, ids, dest), opts);
  const result: TreeMoveResult = { moved: 0, failed: [] };
  for (const id of ids) {
    try {
      await ops.moveItem(ownerId, id, dest);
      result.moved += 1;
    } catch (err) {
      result.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (diff.total > 0 && result.moved) await followShares(ownerId, { ids });
  return result;
}
