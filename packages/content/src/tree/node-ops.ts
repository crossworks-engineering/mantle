/**
 * The tree's writes for every kind whose folders are rows only (everything but
 * Files, whose folders are real directories). A folder is a `branch` row under
 * the kind's root; an item's location is its `path`; moving or renaming a
 * folder rewrites the path of everything below it in one statement.
 *
 * The rules match Files so the tree behaves the same everywhere: the slug
 * (path label) is derived from the name, names are unique per parent by
 * slug, and nothing nests deeper than TREE_MAX_DEPTH folders.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  carrySpaceRows,
  db,
  nodes,
  takeShareWriteLock,
  takeShareReadLock,
  withDeadlockRetry,
  withNodeInsertHeads,
  withNodeMoveHeads,
  withSubtreeHeads,
} from '@mantle/db';
import { dashToLtree, folderSlugOf } from '@mantle/files';
import {
  TREE_KIND_SPECS,
  TREE_MAX_DEPTH,
  TREE_FOLDER_NAME_MAX,
  type TreeKind,
} from '@mantle/client-types/tree';
import { treeParentPath } from '@mantle/content-core/tree';
import { unlessWriteRefused } from './refused-write';

/** A refusal written for people; the write module turns it into a TreeError. */
export class NodeOpRefusal extends Error {
  constructor(
    readonly code: 'not-found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'NodeOpRefusal';
  }
}

const ROOT_TITLE: Record<TreeKind, string> = {
  files: 'Files',
  notes: 'Notes',
  pages: 'Pages',
  draw: 'Draw',
  tables: 'Tables',
  formulas: 'Formulas',
  apps: 'Apps',
  tasks: 'Tasks',
  events: 'Events',
  contacts: 'Contacts',
  secrets: 'Secrets',
  recall: 'Recall',
};

/** Make sure the kind's root row exists (every kind's own create does this
 *  lazily; the tree may be asked for a folder before anything was made).
 *
 *  Reads call this too, so it looks first and writes only a missing root: a
 *  database that refuses writes (refused-write.ts) refuses the insert even
 *  when the row is there. True when the root exists; false when it is missing
 *  and the database refused to make it (the read then finds an empty kind,
 *  and a write that follows fails by itself). */
export async function ensureKindRoot(ownerId: string, kind: TreeKind): Promise<boolean> {
  const root = TREE_KIND_SPECS[kind].root;
  if (await branchAt(ownerId, root)) return true;
  // Heads first (plan U1): a root sits in no folder, so there are none to
  // wait on, but the insert runs in the heads transaction all the same.
  const made = await unlessWriteRefused(() =>
    withNodeInsertHeads(ownerId, [{ type: 'branch', path: root }], (tx) =>
      tx
        .insert(nodes)
        .values({
          ownerId,
          type: 'branch',
          title: ROOT_TITLE[kind],
          slug: root,
          path: root,
          data: {},
          tags: [],
        })
        .onConflictDoNothing({
          target: [nodes.ownerId, nodes.path],
          where: sql`${nodes.type} = 'branch'`,
        }),
    ),
  );
  return made !== null;
}

function slugOf(name: string): string {
  const slug = folderSlugOf(name);
  if (!slug) throw new NodeOpRefusal('invalid', `'${name}' has no letters or digits to name it by`);
  return slug;
}

function displayName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, TREE_FOLDER_NAME_MAX);
}

/** Folder levels below the kind's root for a path (`notes.a.b` is 2). */
function folderDepth(path: string): number {
  return path.split('.').length - 1;
}

type BranchRow = { id: string; path: string; title: string; data: Record<string, unknown> };

async function branchById(ownerId: string, folderId: string): Promise<BranchRow> {
  const [row] = (await db.execute(sql`
    select id, path::text as path, title, data from nodes
     where id = ${folderId} and owner_id = ${ownerId} and type = 'branch'`)) as unknown as Array<{
    id: string;
    path: string;
    title: string;
    data: Record<string, unknown> | null;
  }>;
  if (!row) throw new NodeOpRefusal('not-found', 'folder not found');
  return { ...row, data: row.data ?? {} };
}

async function branchAt(ownerId: string, path: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select 1 from nodes
     where owner_id = ${ownerId} and type = 'branch' and path = ${path}::ltree
     limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/** How many folder levels a folder's subtree spans (1 = no subfolders). */
async function subtreeLevels(ownerId: string, path: string): Promise<number> {
  const [row] = (await db.execute(sql`
    select coalesce(max(nlevel(path)), nlevel(${path}::ltree)) - nlevel(${path}::ltree) + 1 as levels
      from nodes
     where owner_id = ${ownerId} and type = 'branch' and path <@ ${path}::ltree`)) as unknown as Array<{
    levels: number;
  }>;
  return Number(row?.levels ?? 1);
}

/** A write's transaction (the heads helpers hand it over). */
type Tx = Pick<typeof db, 'execute'>;

/**
 * Inside a write's transaction: lock the folder (and the destination folder,
 * for a move) and check again what was checked before it began. Two writes
 * racing (A into B while B goes into A, a rename onto a name just taken) then
 * cannot both pass on a stale read: the second waits for the first and
 * refuses on what it finds.
 */
async function lockAndRecheck(
  tx: Tx,
  ownerId: string,
  folder: BranchRow,
  opts: { destParentPath?: string; newPath: string },
): Promise<void> {
  const dest = opts.destParentPath;
  const rows = (await tx.execute(sql`
    select id, path::text as path from nodes
     where owner_id = ${ownerId} and type = 'branch'
       and (id = ${folder.id} ${dest !== undefined ? sql`or path = ${dest}::ltree` : sql``})
     order by id
     for update`)) as unknown as Array<{ id: string; path: string }>;
  const self = rows.find((r) => r.id === folder.id);
  if (!self || self.path !== folder.path) {
    throw new NodeOpRefusal('conflict', `'${folder.title}' changed meanwhile; try again`);
  }
  if (dest !== undefined && folderDepth(dest) > 0) {
    const d = rows.find((r) => r.path === dest);
    if (!d) throw new NodeOpRefusal('not-found', 'the destination folder was not found');
    if (dest === folder.path || dest.startsWith(`${folder.path}.`)) {
      throw new NodeOpRefusal('invalid', 'a folder cannot move inside itself');
    }
  }
  const [taken] = (await tx.execute(sql`
    select 1 from nodes
     where owner_id = ${ownerId} and type = 'branch' and path = ${opts.newPath}::ltree
     limit 1`)) as unknown as unknown[];
  if (taken) {
    throw new NodeOpRefusal('conflict', `a folder named '${folder.title}' is already there`);
  }
}

/**
 * Rewrite the path of a folder and everything below it (folders and items:
 * an item's path IS its folder's). The folder's own row maps straight to the
 * new path (subpath at its own depth would throw). Items keep their
 * `updated_at`: filing something is not editing it. Members' drafts and
 * folders under a brain folder follow it (carrySpaceRows).
 *
 * @heads-held by renameNodeFolder, moveNodeFolder
 */
async function rewriteSubtree(
  tx: Tx,
  ownerId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  await tx.execute(sql`
    update nodes
       set path = case
             when path = ${oldPath}::ltree then text2ltree(${newPath})
             else (text2ltree(${newPath}) || subpath(path, nlevel(${oldPath}::ltree)))::ltree
           end
     where owner_id = ${ownerId} and path <@ ${oldPath}::ltree`);
  await carrySpaceRows(tx, ownerId, oldPath, newPath);
}

export async function createNodeFolder(
  ownerId: string,
  parentPath: string,
  name: string,
  /** A migration keeping ids and looks it already had (the app-nav folders). */
  opts: { id?: string; data?: Record<string, unknown>; slug?: string } = {},
): Promise<string> {
  const title = displayName(name);
  const slug = opts.slug ?? slugOf(title);
  const path = `${parentPath}.${dashToLtree(slug)}`;
  if (folderDepth(path) > TREE_MAX_DEPTH) {
    throw new NodeOpRefusal('invalid', `folders nest at most ${TREE_MAX_DEPTH} deep`);
  }
  if (!(await branchAt(ownerId, parentPath))) {
    throw new NodeOpRefusal('not-found', 'the folder to create it in was not found');
  }
  if (await branchAt(ownerId, path)) {
    throw new NodeOpRefusal('conflict', `a folder named '${title}' already exists here`);
  }
  // Heads first (plan U1): the parent folder, shared.
  const [row] = await withNodeInsertHeads(ownerId, [{ type: 'branch', path }], (tx) =>
    tx
      .insert(nodes)
      .values({
        ...(opts.id ? { id: opts.id } : {}),
        ownerId,
        type: 'branch',
        title,
        slug,
        path,
        data: opts.data ?? {},
        tags: [],
      })
      .returning({ id: nodes.id }),
  );
  if (!row) throw new Error('createNodeFolder: insert returned no row');
  return row.id;
}

export async function renameNodeFolder(
  ownerId: string,
  folderId: string,
  name: string,
): Promise<void> {
  const folder = await branchById(ownerId, folderId);
  const title = displayName(name);
  const slug = slugOf(title);
  const newPath = `${treeParentPath(folder.path)}.${dashToLtree(slug)}`;
  if (newPath === folder.path) {
    // A new casing or spacing of the same slug: only the name changes.
    await db
      .update(nodes)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(nodes.id, folderId), eq(nodes.ownerId, ownerId)));
    return;
  }
  if (await branchAt(ownerId, newPath)) {
    throw new NodeOpRefusal('conflict', `a folder named '${title}' already exists here`);
  }
  // Heads first (plan V3): the folder and everything below it, and its parent.
  const node = { id: folder.id, type: 'branch', path: folder.path };
  await withDeadlockRetry(() =>
    withNodeMoveHeads(ownerId, node, newPath, async (tx) => {
      await takeShareWriteLock(tx, ownerId);
      await lockAndRecheck(tx, ownerId, folder, { newPath });
      await rewriteSubtree(tx, ownerId, folder.path, newPath);
      await tx
        .update(nodes)
        .set({ title, slug, updatedAt: new Date() })
        .where(and(eq(nodes.id, folderId), eq(nodes.ownerId, ownerId)));
    }),
  );
}

export async function moveNodeFolder(
  ownerId: string,
  folderId: string,
  destParentPath: string,
): Promise<void> {
  const folder = await branchById(ownerId, folderId);
  if (destParentPath === folder.path || destParentPath.startsWith(`${folder.path}.`)) {
    throw new NodeOpRefusal('invalid', 'a folder cannot move inside itself');
  }
  if (!(await branchAt(ownerId, destParentPath))) {
    throw new NodeOpRefusal('not-found', 'the destination folder was not found');
  }
  const label = folder.path.split('.').at(-1)!;
  const newPath = `${destParentPath}.${label}`;
  const levels = await subtreeLevels(ownerId, folder.path);
  if (folderDepth(destParentPath) + levels > TREE_MAX_DEPTH) {
    throw new NodeOpRefusal(
      'invalid',
      `'${folder.title}' and its subfolders would nest deeper than ${TREE_MAX_DEPTH} levels there`,
    );
  }
  if (await branchAt(ownerId, newPath)) {
    throw new NodeOpRefusal(
      'conflict',
      `the destination already has a folder named '${folder.title}'`,
    );
  }
  // Heads first (plan V3): the folder and everything below it, the folder it
  // leaves and the one it lands in.
  const node = { id: folder.id, type: 'branch', path: folder.path };
  await withDeadlockRetry(() =>
    withNodeMoveHeads(ownerId, node, newPath, async (tx) => {
      await takeShareWriteLock(tx, ownerId);
      await lockAndRecheck(tx, ownerId, folder, { destParentPath, newPath });
      await rewriteSubtree(tx, ownerId, folder.path, newPath);
      await tx
        .update(nodes)
        .set({ updatedAt: new Date() })
        .where(and(eq(nodes.id, folderId), eq(nodes.ownerId, ownerId)));
    }),
  );
}

export async function moveNodeItem(
  ownerId: string,
  kind: TreeKind,
  itemId: string,
  destPath: string,
): Promise<void> {
  // Heads first (plan V3): the item, the folder it leaves and the one it
  // lands in, so its current path is read before the transaction.
  const type = TREE_KIND_SPECS[kind].nodeType;
  const [item] = (await db.execute(sql`
    select path::text as path from nodes
     where id = ${itemId} and owner_id = ${ownerId} and type = ${type}`)) as unknown as Array<{
    path: string;
  }>;
  if (!item) throw new NodeOpRefusal('not-found', 'not found');
  const node = { id: itemId, type, path: item.path };
  const moved = await withDeadlockRetry(() =>
    withNodeMoveHeads(ownerId, node, destPath, async (tx) => {
      // The share lock (shared) before the row: see takeShareReadLock.
      await takeShareReadLock(tx, ownerId);
      return tx
        .update(nodes)
        .set({ path: destPath })
        .where(
          and(
            eq(nodes.id, itemId),
            eq(nodes.ownerId, ownerId),
            sql`${nodes.type} = ${TREE_KIND_SPECS[kind].nodeType}`,
          ),
        )
        .returning({ id: nodes.id });
    }),
  );
  if (!moved.length) throw new NodeOpRefusal('not-found', 'not found');
}

/**
 * Delete a folder and lift everything it holds one level up, in one
 * transaction (rows-only kinds; Files go through the disk, write.ts). A row
 * at `P.rest` lands at `Q.rest`, `Q` being the parent: so a subfolder whose
 * landing path is already a folder merges into it (that folder keeps its
 * name, look and share; the subfolder's row goes and what it held lands
 * there, recursively), and every other subfolder moves up whole. Items can
 * share titles: nothing is renamed. Members' drafts and folders follow the
 * same mapping (carrySpaceRows, lift).
 */
export async function deleteNodeFolderMerging(ownerId: string, folderId: string): Promise<void> {
  const folder = await branchById(ownerId, folderId);
  const p = folder.path;
  const q = treeParentPath(p);
  const landing = sql`(case when n.path = ${p}::ltree then ${q}::ltree
                            else ${q}::ltree || subpath(n.path, nlevel(${p}::ltree)) end)`;
  // Heads first (plan V3, V4): the folder and everything below it, its
  // parent (where the rest lands) and the folders outside it that subfolders
  // merge into (what they held lands there). Read again on a retry.
  await withDeadlockRetry(async () => {
    const into = (
      (await db.execute(sql`
        select distinct b.id::text as id from nodes n
          join nodes b on b.owner_id = ${ownerId} and b.type = 'branch'
                      and b.path = ${landing} and not (b.path <@ ${p}::ltree)
         where n.owner_id = ${ownerId} and n.type = 'branch'
           and n.path <@ ${p}::ltree and n.id <> ${folderId}`)) as unknown as Array<{ id: string }>
    ).map((r) => r.id);
    return withSubtreeHeads(folderId, into, async (tx) => {
      await takeShareWriteLock(tx, ownerId);
      const [self] = (await tx.execute(sql`
      select path::text as path from nodes
       where id = ${folderId} and owner_id = ${ownerId} and type = 'branch'
       for update`)) as unknown as Array<{ path: string }>;
      if (!self || self.path !== p) {
        throw new NodeOpRefusal('conflict', `'${folder.title}' changed meanwhile; try again`);
      }
      // 1. Subfolders that merge: a folder is already at their landing path,
      //    outside the deleted one. Their contents land in it below.
      await tx.execute(sql`
      delete from nodes n
       where n.owner_id = ${ownerId} and n.type = 'branch'
         and n.path <@ ${p}::ltree and n.id <> ${folderId}
         and exists (select 1 from nodes b
                      where b.owner_id = ${ownerId} and b.type = 'branch'
                        and b.path = ${landing} and not (b.path <@ ${p}::ltree))`);
      // 2. The folder itself (a shared one refreshes what sat below: 0207).
      await tx.execute(sql`delete from nodes where id = ${folderId} and owner_id = ${ownerId}`);
      // 3. The rest moves up one level, shallowest first: a row's landing path
      //    can be the old path of a row one level up (a subfolder named like
      //    the deleted folder), and that row has moved by then. Items keep
      //    their updated_at: filing is not editing.
      const [deepest] = (await tx.execute(sql`
      select coalesce(max(nlevel(path)), 0)::int as n from nodes
       where owner_id = ${ownerId} and path <@ ${p}::ltree`)) as unknown as Array<{ n: number }>;
      for (let level = folderDepth(p) + 1; level <= Number(deepest?.n ?? 0); level++) {
        await tx.execute(sql`
        update nodes n set path = ${landing}
         where n.owner_id = ${ownerId} and n.path <@ ${p}::ltree and nlevel(n.path) = ${level}`);
      }
      await carrySpaceRows(tx, ownerId, p, q, { lift: true });
    });
  });
}
