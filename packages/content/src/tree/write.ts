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
import { db, isCheckViolation, nodes, takeShareWriteLock, isBusy, BUSY_MESSAGE } from '@mantle/db';
import {
  createFolder as createFilesFolder,
  moveFileById,
  moveFolderById,
  renameFolderById,
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
  withEmbedChanges,
} from './visibility';
import { refoldPageTexts } from '../pages/level-text';
import {
  NodeOpRefusal,
  createNodeFolder,
  deleteNodeFolderMerging,
  moveNodeFolder,
  moveNodeItem,
  renameNodeFolder,
} from './node-ops';
import { treeFolderById } from './read';
import { FilesMergeRefusal, deleteFilesFolderMerging } from './files-merge';

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
};

/** Every kind but Files: folders and locations are rows only. */
function nodeOps(kind: TreeKind): TreeKindOps {
  return {
    createFolder: createNodeFolder,
    renameFolder: renameNodeFolder,
    moveFolder: moveNodeFolder,
    moveItem: (ownerId, itemId, destPath) => moveNodeItem(ownerId, kind, itemId, destPath),
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
  } catch (first) {
    // Another write held these rows (a deadlock broken, or the share lock's
    // timeout): its transaction rolled back, so once more, then a plain
    // "busy" (review F7). Never the SQL text.
    if (!isBusy(first)) return refusingError(first);
    try {
      return await run();
    } catch (err) {
      if (isBusy(err)) throw new TreeError('conflict', BUSY_MESSAGE);
      return refusingError(err);
    }
  }
}

function refusingError(err: unknown): never {
  if (err instanceof TreeError) throw err;
  if (err instanceof NodeOpRefusal) throw new TreeError(err.code, err.message);
  if (err instanceof FilesMergeRefusal) throw new TreeError('conflict', err.message);
  const message = err instanceof Error ? err.message : String(err);
  throw new TreeError(/already exists|unique/i.test(message) ? 'conflict' : 'invalid', message);
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
    // A different change than was shown asks again; none at all goes ahead.
    (opts.confirm && opts.seen !== undefined && d.total > 0 && d.total !== opts.seen);
  if (refused) throw new TreeVisibilityError(await withEmbedChanges(ownerId, d));
  return d;
}

/**
 * After a write changed where items sit relative to shared folders: the
 * database has already carried what they embed along (nodes.embedded_level,
 * migration 0208; nothing's own level changes), so what is left is the
 * indexed text: the pages concerned, the items they reach through embeds,
 * and the pages that name any of them are folded for the level they are now
 * read at (pages/level-text.ts). `scope` is a subtree path, or ids.
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
    select r.id::text as id from mantle_embeds_reached(${ownerId}::uuid, array(
      select id from nodes where owner_id = ${ownerId} and ${where})) r`)) as unknown as Array<{
    id: string;
  }>;
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += REFOLD_BATCH) {
    await refoldPageTexts(ownerId, ids.slice(i, i + REFOLD_BATCH));
  }
}

/** Ids per refold: each names a pattern the refold matches page docs by. */
const REFOLD_BATCH = 200;

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
    if (isBusy(err)) throw new TreeError('conflict', BUSY_MESSAGE);
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
 * Delete a folder; everything it holds moves up to its parent first, and
 * nothing inside is deleted (folder plan section 5). A subfolder whose name
 * is already taken there MERGES into that folder, recursively: the folder
 * that was there keeps its name, look and share, and what merged in takes
 * that share. A file whose name is taken there gets a new one
 * (`report-2.pdf`); other kinds may share titles. The visibility confirm
 * compares every row at its real landing place (visibility.ts liftDiff).
 * Files go through the disk (files-merge.ts, checked read only first);
 * every other kind is one transaction (node-ops.ts).
 */
export async function deleteTreeFolder(
  ownerId: string,
  kind: TreeKind,
  folderId: string,
  opts: TreeWriteOpts = {},
): Promise<void> {
  opsFor(kind);
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
  await refusing(() =>
    kind === 'files'
      ? deleteFilesFolderMerging(ownerId, folderId)
      : deleteNodeFolderMerging(ownerId, folderId),
  );
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
      result.failed.push({
        id,
        error: isBusy(err) ? BUSY_MESSAGE : err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (diff.total > 0 && result.moved) await followShares(ownerId, { ids });
  return result;
}
