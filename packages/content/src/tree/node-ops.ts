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
import { carrySpaceRows, db, nodes, takeShareWriteLock, takeShareReadLock } from '@mantle/db';
import { dashToLtree, folderSlugOf } from '@mantle/files';
import {
  TREE_KIND_SPECS,
  TREE_MAX_DEPTH,
  TREE_FOLDER_NAME_MAX,
  type TreeKind,
} from '@mantle/client-types/tree';
import { treeParentPath } from '@mantle/content-core/tree';

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
 *  lazily; the tree may be asked for a folder before anything was made). */
export async function ensureKindRoot(ownerId: string, kind: TreeKind): Promise<void> {
  const root = TREE_KIND_SPECS[kind].root;
  await db
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
    });
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 */
async function rewriteSubtree(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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
  const [row] = await db
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
    .returning({ id: nodes.id });
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
  await db.transaction(async (tx) => {
    await takeShareWriteLock(tx, ownerId);
    await lockAndRecheck(tx, ownerId, folder, { newPath });
    await rewriteSubtree(tx, ownerId, folder.path, newPath);
    await tx
      .update(nodes)
      .set({ title, slug, updatedAt: new Date() })
      .where(and(eq(nodes.id, folderId), eq(nodes.ownerId, ownerId)));
  });
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
  await db.transaction(async (tx) => {
    await takeShareWriteLock(tx, ownerId);
    await lockAndRecheck(tx, ownerId, folder, { destParentPath, newPath });
    await rewriteSubtree(tx, ownerId, folder.path, newPath);
    await tx
      .update(nodes)
      .set({ updatedAt: new Date() })
      .where(and(eq(nodes.id, folderId), eq(nodes.ownerId, ownerId)));
  });
}

export async function moveNodeItem(
  ownerId: string,
  kind: TreeKind,
  itemId: string,
  destPath: string,
): Promise<void> {
  // The share lock (shared) before the row: see takeShareReadLock.
  const moved = await db.transaction(async (tx) => {
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
  });
  if (!moved.length) throw new NodeOpRefusal('not-found', 'not found');
}

export async function removeEmptyNodeFolder(ownerId: string, folderId: string): Promise<void> {
  const folder = await branchById(ownerId, folderId);
  // Members' drafts and folders in it move up to the parent (never deleted).
  // Emptiness is checked on the locked row, in the delete's transaction.
  await db.transaction(async (tx) => {
    await takeShareWriteLock(tx, ownerId);
    await tx.execute(sql`
      select 1 from nodes where id = ${folderId} and owner_id = ${ownerId} for update`);
    const inside = (await tx.execute(sql`
      select 1 from nodes
       where owner_id = ${ownerId} and path <@ ${folder.path}::ltree and id <> ${folderId}
       limit 1`)) as unknown as unknown[];
    if (inside.length) throw new NodeOpRefusal('conflict', 'the folder is not empty');
    await carrySpaceRows(tx, ownerId, folder.path, treeParentPath(folder.path), { lift: true });
    await tx.delete(nodes).where(and(eq(nodes.id, folderId), eq(nodes.ownerId, ownerId)));
  });
  // Anything filed into it while it went (an upload racing the delete) took
  // its share on the way in: settle what sits at its path now.
  await db.execute(sql`select mantle_refresh_inherited(${ownerId}::uuid, ${folder.path}::ltree)`);
}
