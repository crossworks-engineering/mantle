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
import {
  defineDomainError,
  editCheckRefusalError,
  errorMessage,
  publicErrorMessage,
} from '@mantle/std';
import {
  assertItemRight,
  BUSY_MESSAGE,
  db,
  executeWrite,
  isBusy,
  isScopeWriteRefusal,
  itemWriteVerdicts,
  nodes,
  systemStep,
} from '@mantle/db';
import {
  createFolder as createFilesFolder,
  moveFileById,
  moveFolderById,
  renameFolderById,
  type MoveGuard,
} from '@mantle/files';
import type { AppTint } from '@mantle/client-types/app-nav';
import {
  TREE_FOLDER_NAME_MAX,
  TREE_KIND_SPECS,
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
  type VisibilityDiff,
  withEmbedChanges,
  changeCount,
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
    await executeWrite(
      sql`SELECT pg_notify(${TREE_CHANGED_CHANNEL}, ${JSON.stringify({ ownerId, kind })})`,
    );
    // A client from before the tree draws Apps from /api/app-nav and refetches
    // on this (app-nav.ts APP_NAV_CHANGED_CHANNEL; named here to keep the
    // tree module free of the app-nav one).
    if (kind === 'apps')
      await executeWrite(sql`SELECT pg_notify('app_nav_changed', ${ownerId}::text)`);
  } catch (err) {
    bestEffortFailed('notify', err instanceof Error ? err.message : String(err));
  }
}

/** The one log line of this module's best-effort steps (a notify, the share
 *  follow-up): the write they follow stands. */
function bestEffortFailed(what: string, why: string): void {
  console.error(`[tree] ${what} failed:`, why);
}

/** A refusal the caller can show: `not-found` (404), `conflict` (409),
 *  `invalid` (400), `gone` (410: a retired request, the folder share). */
export class TreeError extends Error {
  constructor(
    readonly code: 'not-found' | 'conflict' | 'invalid' | 'gone',
    message: string,
  ) {
    super(message);
    this.name = 'TreeError';
  }
}

// The one error answer (A10 part 2, @mantle/std domain-errors.ts): what
// treeErrorResponse answered by hand in each route.
defineDomainError(TreeError, {
  reason: 'a folder write the caller asked for cannot be done as asked; the message says why',
  status: (e) =>
    e.code === 'not-found' ? 404 : e.code === 'conflict' ? 409 : e.code === 'gone' ? 410 : 400,
  body: (e) => (e.code === 'gone' ? { error: e.message, code: 'gone' } : { error: e.message }),
});

/** The per-kind half of a write. Paths are ltree strings. */
type TreeKindOps = {
  /** Returns the new folder's id. `look` (icon, color) rides in the row
   *  insert of the create itself, for every kind. */
  createFolder(
    ownerId: string,
    parentPath: string,
    name: string,
    look?: TreeFolderLook,
  ): Promise<string>;
  renameFolder(ownerId: string, folderId: string, name: string): Promise<void>;
  moveFolder(ownerId: string, folderId: string, destParentPath: string): Promise<void>;
  moveItem(ownerId: string, itemId: string, destPath: string, guard?: MoveGuard): Promise<void>;
};

const FILES_OPS: TreeKindOps = {
  async createFolder(ownerId, parentPath, name, look) {
    return (await createFilesFolder({ ownerId, parentPath, slug: name, name, ...look })).id;
  },
  async renameFolder(ownerId, folderId, name) {
    await renameFolderById({ ownerId, folderId, newSlug: name });
  },
  async moveFolder(ownerId, folderId, destParentPath) {
    await moveFolderById({ ownerId, folderId, destParentPath });
  },
  async moveItem(ownerId, itemId, destPath, guard) {
    await moveFileById({ ownerId, fileId: itemId, destPath, guard });
  },
};

/** Every kind but Files: folders and locations are rows only. */
function nodeOps(kind: TreeKind): TreeKindOps {
  return {
    createFolder: (ownerId, parentPath, name, look) =>
      createNodeFolder(ownerId, parentPath, name, look ? { data: look } : {}),
    renameFolder: renameNodeFolder,
    moveFolder: moveNodeFolder,
    moveItem: (ownerId, itemId, destPath, guard) =>
      moveNodeItem(ownerId, kind, itemId, destPath, guard),
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
  // The database refused it under the caller's workspaces (W6a fix round 1):
  // the HTTP layer answers 403 item-workspace, never the SQL.
  if (isScopeWriteRefusal(err)) throw err;
  const message = errorMessage(err);
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

/** A folder's stored look: what of `icon` and `color` is set (an empty
 *  string or null is "none" and is left out). */
type TreeFolderLook = { icon?: string; color?: AppTint };

function lookOf(args: { icon?: string | null; color?: AppTint | null }): TreeFolderLook | null {
  const look: TreeFolderLook = {};
  if (args.icon) look.icon = args.icon;
  if (args.color) look.color = args.color;
  return Object.keys(look).length ? look : null;
}

/** Create a folder under `parentId` (null = the top level), with its look
 *  when given, in the one call. */
export async function createTreeFolder(
  ownerId: string,
  kind: TreeKind,
  args: { parentId: string | null; name: string; icon?: string | null; color?: AppTint | null },
): Promise<TreeFolder> {
  const ops = opsFor(kind);
  const parentPath = await pathOf(ownerId, kind, args.parentId);
  const name = cleanName(args.name);
  const look = lookOf(args);
  const id = await refusing(() => ops.createFolder(ownerId, parentPath, name, look ?? undefined));
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
  /** RETIRED (workspaces W5b2): a folder share is a grant now, set in the
   *  folder's Grant Access panel. Any value is refused with `gone`. */
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
  /** Item moves only: checked again inside each item's transaction, under
   *  its heads (the grants API re-plans a move into a folder there). */
  guard?: MoveGuard;
};

async function checkVisibility(
  ownerId: string,
  diff: Promise<VisibilityDiff>,
  opts: TreeWriteOpts,
): Promise<VisibilityDiff> {
  // What the items embed counts as a change of its own: a note already read
  // at the folder's share still opens its embeds there (review F6).
  const d = await withEmbedChanges(ownerId, await diff);
  const n = changeCount(d);
  const refused =
    (n > 0 && !opts.confirm) ||
    // A different change than was shown asks again; none at all goes ahead.
    (opts.confirm && opts.seen !== undefined && n > 0 && n !== opts.seen);
  if (refused) throw new TreeVisibilityError(d);
  return d;
}

/**
 * After a write changed where items sit relative to shared folders: the
 * database has already carried what they embed along (migration 0208;
 * nothing's own level changes), so what is left is the
 * indexed text: the pages concerned, the items they reach through embeds,
 * and the pages that name any of them are folded for the level they are now
 * read at (pages/level-text.ts). `scope` is a subtree path, or ids.
 *
 * The items it starts from are read in the caller's scope (the ones it
 * moved and reads); the walk and the fold are the brain's, the named system
 * step 'tree-refold' (S11a-5): the walk reads node_embeds, which no
 * workspace scope reads, so in the caller's scope a member's move answered
 * a database error after the move had been made; and the pages reached are
 * folded whoever reads them, as a grant change folds them (grants.ts
 * refoldAfter). Nothing it reads goes back to the caller.
 */
async function followShares(
  ownerId: string,
  scope: { path: string } | { ids: readonly string[] },
): Promise<void> {
  // After the write committed: best effort (as a grant change's refold,
  // grants.ts refoldAfter). A failure is logged and the write stands, so a
  // move is never reported failed for it; the page's next save folds it.
  try {
    // One uuid[] parameter for any number of ids (a bind per id stops at
    // 65,535).
    const where =
      'path' in scope
        ? sql`path <@ ${scope.path}::ltree`
        : sql`id = any(${`{${scope.ids.join(',')}}`}::uuid[])`;
    const start = (
      (await db.execute(sql`
        select id::text as id from nodes where owner_id = ${ownerId} and ${where}`)) as unknown as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    if (!start.length) return;
    await systemStep(
      'tree-refold',
      { items: start, need: 'read', only: 'allowed' },
      async (allowed) => {
        if (!allowed.length) return;
        const rows = (await db.execute(sql`
          select r.id::text as id
            from mantle_embeds_reached(${ownerId}::uuid, ${`{${allowed.join(',')}}`}::uuid[]) r`)) as unknown as Array<{
          id: string;
        }>;
        const ids = rows.map((r) => r.id);
        for (let i = 0; i < ids.length; i += REFOLD_BATCH) {
          await refoldPageTexts(ownerId, ids.slice(i, i + REFOLD_BATCH));
        }
      },
    );
  } catch (err) {
    bestEffortFailed('share follow-up', publicErrorMessage(err, 'tree refold'));
  }
}

/** Ids per refold: each names a pattern the refold matches page docs by. */
const REFOLD_BATCH = 200;

/** The refusal of a folder share (workspaces W5b2). */
export const FOLDER_SHARE_GONE =
  "Folder sharing levels are gone. Use the folder's Grant Access panel to share it with a workspace.";

/** Apply one or more changes to a folder, in a fixed order: move, rename,
 *  look, then place. Returns the folder as it now is. */
export async function updateTreeFolder(
  ownerId: string,
  kind: TreeKind,
  folderId: string,
  patch: TreeFolderPatch,
  opts: TreeWriteOpts = {},
): Promise<TreeFolder> {
  // A folder share is a grant now (workspaces W5b2): refused before
  // anything else is written, so the rest of the patch does not half apply.
  if (patch.share !== undefined) throw new TreeError('gone', FOLDER_SHARE_GONE);
  const ops = opsFor(kind);
  const folder = await folderOrThrow(ownerId, kind, folderId);
  if (patch.parentId !== undefined) {
    if (patch.parentId === folderId) throw new TreeError('invalid', 'a folder cannot hold itself');
    if (folder.system && patch.parentId !== folder.parentId) {
      throw new TreeError('invalid', 'this folder is made by Mantle; it stays where it is');
    }
    const dest = await pathOf(ownerId, kind, patch.parentId);
    if (dest !== treeParentPath(folder.path)) {
      const diff = await checkVisibility(ownerId, moveFolderDiff(ownerId, folder, dest), opts);
      await refusing(() => ops.moveFolder(ownerId, folderId, dest));
      if (changeCount(diff) > 0) {
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
  return folderOrThrow(ownerId, kind, folderId);
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
  // The folder's manage first (pre-check removal Part 3): the Files kind lifts the
  // children out before the folder's checked DELETE, so a caller that may
  // not delete the folder moves nothing (and learns nothing of what it holds).
  await assertItemRight(folderId, 'manage');
  const folder = await folderOrThrow(ownerId, kind, folderId);
  if (folder.system) {
    throw new TreeError('invalid', 'this folder is made by Mantle; it cannot be deleted');
  }
  const diff = await checkVisibility(ownerId, liftDiff(ownerId, folder), opts);
  const affected = changeCount(diff)
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
  // The whole list asked first (pre-check removal Part 3): each item moves on its own and
  // the database refuses item by item, so one the caller may not move would
  // leave the others moved. One it may not move refuses the call, nothing
  // moved, before the visibility question (it names workspaces).
  const verdicts = await itemWriteVerdicts(ids, 'manage');
  for (const id of ids) {
    const v = verdicts.get(id) ?? 'no_read';
    if (v !== 'ok') throw editCheckRefusalError(v);
  }
  const diff = await checkVisibility(ownerId, moveItemsDiff(ownerId, kind, ids, dest), opts);
  const result: TreeMoveResult = { moved: 0, failed: [] };
  for (const id of ids) {
    try {
      await ops.moveItem(ownerId, id, dest, opts.guard);
      result.moved += 1;
    } catch (err) {
      result.failed.push({
        id,
        error: isBusy(err) ? BUSY_MESSAGE : publicErrorMessage(err, 'tree move'),
      });
    }
  }
  if (changeCount(diff) > 0 && result.moved) await followShares(ownerId, { ids });
  return result;
}
