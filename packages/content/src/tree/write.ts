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
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  defineDomainError,
  editCheckRefusalError,
  errorMessage,
  publicErrorMessage,
  UUID_RE,
} from '@mantle/std';
import {
  advisoryXactLock,
  assertItemRight,
  busyMessage,
  currentWorkspaceScope,
  db,
  executeWrite,
  isBusy,
  isPoolBusy,
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
import { RANK_RE } from '../rank';
import { TREE_ORDER_MAX, planWhole, rankAt, type OrderRow, type RankWrite } from './order-plan';
import { isTreeLiveKind, kindItemFilter } from './kinds';
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
import { treeFallbackSort, treeFolderById, treeItemOrderBy } from './read';
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
    // A pool's wait run out: not again (it would wait the whole bound twice).
    if (isPoolBusy(first)) throw new TreeError('conflict', busyMessage(first));
    try {
      return await run();
    } catch (err) {
      if (isBusy(err)) throw new TreeError('conflict', busyMessage(err));
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
  // A place is asked of the folder it lands in before anything is written,
  // so a move and a place never half apply: the folder to follow is a
  // folder there (not this one), and the caller may order it.
  if (patch.after !== undefined) {
    if (patch.after === folderId) throw new TreeError('invalid', 'nothing can follow itself');
    const dest =
      patch.parentId !== undefined
        ? await pathOf(ownerId, kind, patch.parentId)
        : treeParentPath(folder.path);
    if (patch.after !== null && !(await isFolderIn(ownerId, patch.after, dest))) {
      throw new TreeError('invalid', AFTER_NOT_HERE);
    }
    await assertMayOrder(ownerId, kind, dest);
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

/** The refusal of an `after` that names no child of the folder the place
 *  is in. */
const AFTER_NOT_HERE = 'the one to place after is not in this folder';

/** Whether `id` is a folder directly in the folder at `parentPath` (as the
 *  caller reads it). */
async function isFolderIn(ownerId: string, id: string, parentPath: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const rows = (await db.execute(sql`
    select 1 from nodes n
     where n.id = ${id}::uuid and n.owner_id = ${ownerId} and n.type = 'branch'
       and n.path ~ ${`${parentPath}.*{1}`}::lquery
     limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/** A folder's look in one statement: only the keys asked are set or
 *  dropped, so a place (`rank`) written meanwhile is never overwritten. */
async function setFolderLook(
  ownerId: string,
  folderId: string,
  look: { icon?: string | null; color?: AppTint | null },
): Promise<void> {
  const set: Record<string, string> = {};
  const drop: string[] = [];
  for (const key of ['icon', 'color'] as const) {
    const value = look[key];
    if (value === undefined) continue;
    if (value === null || value === '') drop.push(key);
    else set[key] = value;
  }
  await db
    .update(nodes)
    .set({
      data: sql`(coalesce(${nodes.data}, '{}'::jsonb) - ${`{${drop.join(',')}}`}::text[]) || ${JSON.stringify(set)}::text::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(nodes.id, folderId), eq(nodes.ownerId, ownerId)));
}

/** A place is no edit of what it orders: the transaction keeps each row's
 *  `updated_at` (touch_updated_at reads mantle.keep_updated_at), so "last
 *  updated" and the extractor never see an order change. */
async function keepUpdatedAt(tx: Pick<typeof db, 'execute'>): Promise<void> {
  await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
}

/** The refusal of an order at the top level outside an Admin scope. */
export const TOP_LEVEL_ORDER_REFUSED =
  'Only an Admin orders the top level. Ask for Write on a folder to order what is in it.';

/** An order the caller may not set: the top level outside an Admin scope
 *  (403, its own words; a folder's refusal is the item check's). */
export class TreeOrderRefusal extends Error {
  constructor() {
    super(TOP_LEVEL_ORDER_REFUSED);
    this.name = 'TreeOrderRefusal';
  }
}

defineDomainError(TreeOrderRefusal, {
  reason: 'an order of the top level outside an Admin scope; the message says who may',
  status: 403,
});

/**
 * Whether the caller may set the order of what the folder at `path` holds
 * (its items and its subfolders): Write on that folder, or an Admin scope at
 * the kind's top level, which is in no folder (owner decision 2026-10-26).
 * The order is one for everyone. The database asks the same of the rank it
 * writes: edit of the item or of its folder (the presentation key, 0281).
 * System work is not checked.
 */
export async function mayOrderFolder(
  ownerId: string,
  kind: TreeKind,
  path: string,
): Promise<boolean> {
  if (!currentWorkspaceScope()) return true;
  if (path === TREE_KIND_SPECS[kind].root) {
    const [row] = (await db.execute(
      sql`select "public"."mantle_may_manage_home"(NULL) as ok`,
    )) as unknown as Array<{ ok: boolean | null }>;
    return row?.ok === true;
  }
  const folderId = await folderIdAt(ownerId, path);
  if (!folderId) return false;
  return (await itemWriteVerdicts([folderId], 'edit')).get(folderId) === 'ok';
}

/** Throws the edit check's refusal unless the caller may order the folder
 *  at `path` (mayOrderFolder). */
async function assertMayOrder(ownerId: string, kind: TreeKind, path: string): Promise<void> {
  if (!currentWorkspaceScope()) return;
  if (path === TREE_KIND_SPECS[kind].root) {
    if (!(await mayOrderFolder(ownerId, kind, path))) throw new TreeOrderRefusal();
    return;
  }
  const folderId = await folderIdAt(ownerId, path);
  // A folder the caller does not read: "not in your workspaces".
  if (!folderId) throw editCheckRefusalError('no_read');
  await assertItemRight(folderId, 'edit');
}

/** The id of the folder at `path`, when the caller reads it. */
async function folderIdAt(ownerId: string, path: string): Promise<string | null> {
  const [row] = (await db.execute(sql`
    select id::text as id from nodes
     where owner_id = ${ownerId} and type = 'branch' and path = ${path}::ltree
     limit 1`)) as unknown as Array<{ id: string }>;
  return row?.id ?? null;
}

/**
 * Put an item directly after `afterId` among the items of its folder (null
 * = first), in the folder's custom order, one for everyone (the tree's
 * `custom` sort). The place is the item's `data.tree_rank` (0335), written
 * without touching `updated_at` (orderChildren).
 */
export async function placeTreeItem(
  ownerId: string,
  kind: TreeKind,
  itemId: string,
  afterId: string | null,
): Promise<void> {
  opsFor(kind);
  const nodeType = TREE_KIND_SPECS[kind].nodeType;
  const root = TREE_KIND_SPECS[kind].root;
  const [item] = (await db.execute(sql`
    select n.id::text as id, n.path::text as path, (n.data ? 'snapshot_of') as copy
      from nodes n
     where n.id = ${itemId}::uuid and n.owner_id = ${ownerId} and n.type = ${nodeType}
       and n.path <@ ${root}::ltree ${kindItemFilter(kind, 'n')}
     limit 1`)) as unknown as Array<{ id: string; path: string; copy: boolean }>;
  if (!item) throw new TreeError('not-found', 'item not found');
  await assertMayOrder(ownerId, kind, item.path);
  if (item.copy) throw new TreeError('invalid', 'a read-only copy keeps its place');
  await orderChildren(ownerId, kind, {
    key: 'tree_rank',
    path: item.path,
    top: item.path === root,
    where: sql`n.owner_id = ${ownerId} and n.type = ${nodeType}
      and n.path = ${item.path}::ltree ${kindItemFilter(kind, 'n')}`,
    orderBy: (ordered) => treeItemOrderBy(ordered ? 'custom' : treeFallbackSort(kind)),
    movingId: itemId,
    afterId,
  });
}

/**
 * Put a folder directly after `afterId` among its sibling folders (null =
 * first): its `data.rank`, through orderChildren as an item's place. The
 * caller's right to order the parent is asked before (updateTreeFolder).
 */
async function placeFolder(
  ownerId: string,
  kind: TreeKind,
  folderId: string,
  afterId: string | null,
): Promise<void> {
  const folder = await folderOrThrow(ownerId, kind, folderId);
  const parentPath = treeParentPath(folder.path);
  await orderChildren(ownerId, kind, {
    key: 'rank',
    path: parentPath,
    top: parentPath === TREE_KIND_SPECS[kind].root,
    where: sql`n.owner_id = ${ownerId} and n.type = 'branch'
      and n.path ~ ${`${parentPath}.*{1}`}::lquery`,
    // The order the tree lists folders in (read.ts listTreeFolders).
    orderBy: () => sql`n.data->>'rank' collate "C" nulls last, lower(n.title), n.id`,
    movingId: folderId,
    afterId,
  });
}

/** One folder's children to order: its items or its subfolders. */
type ChildOrder = {
  /** The key the place is written to: an item's `tree_rank`, a folder's
   *  `rank` (both presentation keys, 0281 and 0335). */
  key: 'tree_rank' | 'rank';
  /** The folder whose children these are (the lock's key). */
  path: string;
  /** The kind's top level: no folder holds the children, so the database
   *  asks edit of each one written. */
  top: boolean;
  /** The children, the moved one among them (alias `n`). */
  where: SQL;
  /** The order the tree shows them in, by whether the folder has an order. */
  orderBy: (ordered: boolean) => SQL;
  movingId: string;
  /** The child to follow; null = first. */
  afterId: string | null;
};

/**
 * Order a folder's children (the gateway of every place: an item's, a
 * folder's). Under an advisory lock on the folder, so places in one folder
 * run one at a time, the children are read in the transaction as the tree
 * shows them and the plan (order-plan.ts) is written in one statement:
 *
 *  - when the moved child's new neighbours (copies left out) both carry a
 *    rank with room between, only it is written. Only those two are read
 *    (nearestRanks), so such a place costs the same in a folder of any
 *    size;
 *  - else the folder is ranked (planWhole): in an ordered folder only the
 *    children with no rank take one, after the rest; in an unordered one
 *    all of them, evenly. Only rows the caller may write take a rank then:
 *    never a read-only snapshot copy, and at the top level only what the
 *    caller may edit (asked then, in the transaction, not on every place).
 *    The children are counted first: a folder of more than TREE_ORDER_MAX
 *    is refused that (409) before any of them is read.
 *
 * At the top level the moved child itself must be the caller's to edit:
 * refused first (the edit check's 403), never silently left where it was.
 * Nothing touches `updated_at` (keepUpdatedAt).
 */
async function orderChildren(ownerId: string, kind: TreeKind, o: ChildOrder): Promise<void> {
  if (o.afterId === o.movingId) throw new TreeError('invalid', 'nothing can follow itself');
  const scoped = currentWorkspaceScope() !== null;
  if (o.top && scoped) {
    const v = (await itemWriteVerdicts([o.movingId], 'edit')).get(o.movingId) ?? 'no_read';
    if (v !== 'ok') throw editCheckRefusalError(v);
  }
  const rankSql = sql`n.data->>${o.key}`;
  await refusing(() =>
    db.transaction(async (tx) => {
      await keepUpdatedAt(tx);
      await advisoryXactLock(
        tx,
        `tree-order:${ownerId}:${kind}:${o.key}:${o.path}`,
        'hashtextextended',
      );
      const near = await nearestRanks(tx, o, rankSql);
      const one = near ? rankAt(near.rows, near.at) : null;
      if (one !== null) {
        await writeRanks(tx, ownerId, o.key, [{ id: o.movingId, rank: one }]);
        return;
      }
      // The whole folder: counted before it is read.
      const [counted] = (await tx.execute(sql`
        select count(*)::int as n from nodes n
         where ${o.where} and n.id <> ${o.movingId}::uuid`)) as unknown as Array<{ n: number }>;
      if (Number(counted?.n ?? 0) + 1 > TREE_ORDER_MAX) {
        throw new TreeError(
          'conflict',
          `This folder holds more than ${TREE_ORDER_MAX.toLocaleString('en-US')} entries, too many to put in order by hand. Sort it another way, or split it into folders.`,
        );
      }
      // A copy's inherited rank makes no order (read.ts hasCustomOrder).
      const [has] = (await tx.execute(sql`
        select exists (select 1 from nodes n
                        where ${o.where} and not (n.data ? 'snapshot_of')
                          and ${rankSql} ~ ${RANK_RE.source}) as ordered`)) as unknown as Array<{
        ordered: boolean;
      }>;
      const ordered = has?.ordered === true;
      const rows: OrderRow[] = (
        (await tx.execute(sql`
          select n.id::text as id, ${rankSql} as rank, (n.data ? 'snapshot_of') as copy
            from nodes n
           where ${o.where} and n.id <> ${o.movingId}::uuid
           order by ${o.orderBy(ordered)}`)) as unknown as Array<{
          id: string;
          rank: string | null;
          copy: boolean;
        }>
      ).map((r) => ({
        id: r.id,
        rank: r.rank !== null && RANK_RE.test(r.rank) ? r.rank : null,
        copy: r.copy === true,
      }));
      const at = o.afterId === null ? 0 : rows.findIndex((r) => r.id === o.afterId) + 1;
      if (o.afterId !== null && at === 0) throw new TreeError('invalid', AFTER_NOT_HERE);
      const single = rankAt(rows, at);
      let writes: RankWrite[];
      if (single !== null) {
        writes = [{ id: o.movingId, rank: single }];
      } else {
        // At the top level the database asks edit of each row: only those
        // take a rank (the moved one was asked above), asked on this
        // transaction's connection.
        const editable =
          o.top && scoped
            ? await itemWriteVerdicts(
                rows.filter((r) => !r.copy).map((r) => r.id),
                'edit',
                tx,
              )
            : null;
        writes = planWhole(
          rows,
          at,
          o.movingId,
          ordered,
          (id) => editable === null || editable.get(id) === 'ok',
        );
      }
      await writeRanks(tx, ownerId, o.key, writes);
    }),
  );
}

/**
 * The moved child's new neighbours, read alone (two keyset reads, each one
 * row): the child to follow and the first one after it that is no copy,
 * in rank order. Null when they cannot settle the place by themselves, so
 * the whole folder is read: the child to follow is a copy or has no rank,
 * the next one has none (or one that is no rank), or the two tie. A child
 * to follow that is not in the folder is refused here (400).
 */
async function nearestRanks(
  tx: Pick<typeof db, 'execute'>,
  o: ChildOrder,
  rankSql: SQL,
): Promise<{ rows: OrderRow[]; at: number } | null> {
  let prev: OrderRow | null = null;
  if (o.afterId !== null) {
    if (!UUID_RE.test(o.afterId)) throw new TreeError('invalid', AFTER_NOT_HERE);
    const [after] = (await tx.execute(sql`
      select n.id::text as id, ${rankSql} as rank, (n.data ? 'snapshot_of') as copy
        from nodes n
       where ${o.where} and n.id = ${o.afterId}::uuid
       limit 1`)) as unknown as Array<{ id: string; rank: string | null; copy: boolean }>;
    if (!after) throw new TreeError('invalid', AFTER_NOT_HERE);
    if (after.copy === true || after.rank === null || !RANK_RE.test(after.rank)) return null;
    prev = { id: after.id, rank: after.rank, copy: false };
  }
  const lo = prev?.rank ?? null;
  // The first child after it in rank order (byte order, as the tree sorts
  // ranks), copies left out; the ones with no rank (or one that is no rank)
  // after every rank, as the tree lists them. When that is one of those,
  // the place needs the whole folder.
  const [next] = (await tx.execute(sql`
    select n.id::text as id, ${rankSql} as rank
      from nodes n
     where ${o.where} and n.id <> ${o.movingId}::uuid
       ${o.afterId !== null ? sql`and n.id <> ${o.afterId}::uuid` : sql``}
       and not (n.data ? 'snapshot_of')
       ${
         lo !== null
           ? sql`and (${rankSql} is null or ${rankSql} !~ ${RANK_RE.source}
                      or (${rankSql} collate "C") >= (${lo} collate "C"))`
           : sql``
       }
     order by (case when ${rankSql} ~ ${RANK_RE.source} then 0 else 1 end),
              ${rankSql} collate "C"
     limit 1`)) as unknown as Array<{ id: string; rank: string | null }>;
  if (next && (next.rank === null || !RANK_RE.test(next.rank) || next.rank === lo)) return null;
  const rows: OrderRow[] = [
    ...(prev ? [prev] : []),
    ...(next ? [{ id: next.id, rank: next.rank, copy: false }] : []),
  ];
  return { rows, at: prev ? 1 : 0 };
}

/** Every rank of a place in one statement (the write check runs per row). */
async function writeRanks(
  tx: Pick<typeof db, 'update'>,
  ownerId: string,
  key: 'tree_rank' | 'rank',
  writes: readonly RankWrite[],
): Promise<void> {
  if (!writes.length) return;
  // One uuid[] and one text[] parameter for any number of rows (a bind per
  // row stops at 65,535); a rank is [0-9a-z] only, safe in the literal.
  const ids = `{${writes.map((w) => w.id).join(',')}}`;
  const ranks = `{${writes.map((w) => w.rank).join(',')}}`;
  await tx
    .update(nodes)
    .set({
      data: sql`jsonb_set(coalesce(${nodes.data}, '{}'::jsonb), ${`{${key}}`}::text[], to_jsonb(place.place_rank))`,
    })
    .from(sql`unnest(${ids}::uuid[], ${ranks}::text[]) as place(place_id, place_rank)`)
    .where(and(eq(nodes.ownerId, ownerId), sql`${nodes.id} = place.place_id`));
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
        error: isBusy(err) ? busyMessage(err) : publicErrorMessage(err, 'tree move'),
      });
    }
  }
  if (changeCount(diff) > 0 && result.moved) await followShares(ownerId, { ids });
  return result;
}
