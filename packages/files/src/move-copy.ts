/**
 * Move and copy — the operations a two-pane file manager stands on.
 *
 * Until these existed the files tree supported rename only: a file lived
 * where it was uploaded, forever. The invariants each op protects:
 *
 *   - **Disk and DB never diverge.** Same discipline as renameFolderById:
 *     disk first (fs.rename is atomic within the tree), then the DB write in
 *     a transaction, and a failed DB write puts the disk back.
 *   - **A move follows the indexing rules of where it LANDS.** Effective
 *     indexing (P1) resolves by folder chain, so moving a file into a
 *     name-only gallery must shed its content index and moving it out must
 *     regain one — `reconcileFilesIndexing` runs after every move, exactly
 *     as if the flag had been flipped.
 *   - **A copy is a new file, not a shared one.** copyFileById re-writes the
 *     bytes through upsertFile, so the new node gets its own sha, its own
 *     extraction (under the DESTINATION's indexing mode), its own life.
 *     Nothing links back — deleting the original never breaks the copy.
 *   - **Folder copies are capped.** Every copied file under a full-indexing
 *     destination re-extracts, which is real LLM spend; an unbounded
 *     recursive copy is the runaway-cost shape. The cap refuses loudly with
 *     the count, rather than trimming silently.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, type Node } from '@mantle/db';
import { moveFile as moveFileOnDisk, renameFolder as renameFolderOnDisk } from './disk';
import { FILES_ROOT_LABEL } from './paths';
import { reconcileFilesIndexing } from './indexing';
import {
  createFolder,
  fileById,
  folderById,
  readFileById,
  upsertFile,
  type FileRow,
  type FolderRow,
} from './ops';

/** Recursive folder copies refuse above this many files. Big enough for a
 *  real folder of documents, small enough that the re-extraction bill is a
 *  considered choice — split a bigger copy into parts on purpose. */
export const COPY_MAX_FILES = 200;

async function branchAt(ownerId: string, path: string): Promise<Node | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'branch'), sql`${nodes.path}::text = ${path}`),
    )
    .limit(1);
  return row ?? null;
}

async function fileInFolder(
  ownerId: string,
  parentPath: string,
  filename: string,
): Promise<Node | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${parentPath}`,
        sql`${nodes.data}->>'filename' = ${filename}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Move ONE file to another folder. Filename travels unchanged (rename is a
 * separate op on purpose — one verb per action keeps the teaching errors
 * specific). Returns the row at its new home.
 */
export async function moveFileById(args: {
  ownerId: string;
  fileId: string;
  /** Destination FOLDER ltree path, e.g. 'files.archive.2026'. */
  destPath: string;
}): Promise<FileRow> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') {
    throw new Error('moveFileById: file not found — find the id with file_list / search_nodes');
  }
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = String(data.filename ?? '');
  if (!filename) throw new Error('moveFileById: file row has no filename');
  if (node.path === args.destPath) {
    const row = await fileById({ ownerId: args.ownerId, fileId: node.id });
    return row!; // no-op move
  }
  const dest = await branchAt(args.ownerId, args.destPath);
  if (!dest) {
    throw new Error(
      `moveFileById: no folder at '${args.destPath}' — create it with folder_create, or find the right path with folder_list`,
    );
  }
  const clash = await fileInFolder(args.ownerId, args.destPath, filename);
  if (clash) {
    throw new Error(
      `moveFileById: '${filename}' already exists in '${args.destPath}' — rename one of them first (file_rename)`,
    );
  }

  const oldPath = node.path;
  await moveFileOnDisk(oldPath, filename, args.destPath);
  try {
    await db
      .update(nodes)
      .set({ path: args.destPath, updatedAt: new Date() })
      .where(eq(nodes.id, node.id));
  } catch (err) {
    await moveFileOnDisk(args.destPath, filename, oldPath).catch(() => {});
    throw err;
  }

  // The destination's folder chain may index differently — reconcile now so
  // "moved into the gallery" behaves exactly like "flagged name-only".
  const [fresh] = await db.select().from(nodes).where(eq(nodes.id, node.id)).limit(1);
  if (fresh) await reconcileFilesIndexing(args.ownerId, [fresh]);

  const row = await fileById({ ownerId: args.ownerId, fileId: node.id });
  return row!;
}

/**
 * Move a FOLDER (and its whole subtree) under another parent. The folder
 * keeps its own name; only its location changes.
 */
export async function moveFolderById(args: {
  ownerId: string;
  folderId: string;
  /** New PARENT folder ltree path. */
  destParentPath: string;
}): Promise<{ folder: FolderRow; requeued: number }> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.folderId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'branch') {
    throw new Error('moveFolderById: folder not found — find the id with folder_list');
  }
  if (node.path === FILES_ROOT_LABEL) {
    throw new Error('moveFolderById: cannot move the files root');
  }
  const destParent = await branchAt(args.ownerId, args.destParentPath);
  if (!destParent) {
    throw new Error(
      `moveFolderById: no folder at '${args.destParentPath}' — create it with folder_create first`,
    );
  }
  const oldPath = node.path;
  const label = oldPath.split('.').at(-1)!;
  const newPath = `${args.destParentPath}.${label}`;
  if (newPath === oldPath) {
    const folder = await folderById({ ownerId: args.ownerId, folderId: node.id });
    return { folder: folder!, requeued: 0 }; // no-op
  }
  // Into itself or a descendant would orphan the subtree ('files.a' →
  // 'files.a.b.a' rewrites the destination while rewriting the source).
  if (args.destParentPath === oldPath || args.destParentPath.startsWith(`${oldPath}.`)) {
    throw new Error(
      `moveFolderById: cannot move '${oldPath}' into its own subtree ('${args.destParentPath}')`,
    );
  }
  if (await branchAt(args.ownerId, newPath)) {
    throw new Error(
      `moveFolderById: a folder named '${label}' already exists under '${args.destParentPath}' — rename one of them first`,
    );
  }

  // Disk first, DB cascade second, disk rollback on DB failure — the exact
  // renameFolderById discipline; the ltree rewrite is the same CASE shape.
  await renameFolderOnDisk(oldPath, newPath);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE ${nodes}
        SET path = CASE
              WHEN path = ${oldPath}::ltree THEN text2ltree(${newPath})
              ELSE (text2ltree(${newPath}) || subpath(path, nlevel(${oldPath}::ltree)))::ltree
            END,
            updated_at = now()
        WHERE owner_id = ${args.ownerId} AND path <@ ${oldPath}::ltree
      `);
    });
  } catch (err) {
    await renameFolderOnDisk(newPath, oldPath).catch(() => {});
    throw err;
  }

  // Every file that moved may now sit under a different indexing chain.
  const movedFiles = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path} <@ ${newPath}::ltree`,
      ),
    );
  const requeued = await reconcileFilesIndexing(args.ownerId, movedFiles);

  const folder = await folderById({ ownerId: args.ownerId, folderId: node.id });
  return { folder: folder!, requeued };
}

/**
 * Copy ONE file into another folder — a genuinely new file with its own
 * node, bytes, and extraction under the destination's indexing mode.
 */
export async function copyFileById(args: {
  ownerId: string;
  fileId: string;
  destPath: string;
  /** Optional new filename (defaults to the source's). Lets a caller resolve
   *  a collision in one call instead of two. */
  newFilename?: string;
}): Promise<FileRow> {
  const src = await readFileById({ ownerId: args.ownerId, fileId: args.fileId });
  if (!src) {
    throw new Error('copyFileById: file not found — find the id with file_list / search_nodes');
  }
  // The raw node, for what FileRow doesn't carry: tags and the file's OWN
  // indexing flag. A copy of a name-only file must stay name-only wherever
  // it lands — dropping the flag would content-index something the owner
  // explicitly marked don't-index, silently (2026-08-22 audit).
  const [srcNode] = await db
    .select({ tags: nodes.tags, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  const srcData = (srcNode?.data ?? {}) as Record<string, unknown>;
  const srcOwnIndexing =
    srcData.indexing === 'metadata' ? 'metadata' : srcData.indexing === 'full' ? 'full' : null;
  const srcTags = (srcNode?.tags ?? []).filter((t) => t !== 'file');
  const dest = await branchAt(args.ownerId, args.destPath);
  if (!dest) {
    throw new Error(
      `copyFileById: no folder at '${args.destPath}' — create it with folder_create first`,
    );
  }
  const filename = args.newFilename?.trim() || src.row.filename;
  // upsertFile(overwrite:false) also refuses collisions; checking first gives
  // the specific teaching error rather than a generic write failure.
  if (await fileInFolder(args.ownerId, args.destPath, filename)) {
    throw new Error(
      `copyFileById: '${filename}' already exists in '${args.destPath}' — pass new_filename to copy under another name`,
    );
  }
  return upsertFile({
    ownerId: args.ownerId,
    parentPath: args.destPath,
    filename,
    bytes: src.bytes,
    title: src.row.title !== src.row.filename ? src.row.title : undefined,
    tags: srcTags,
    ...(srcOwnIndexing ? { data: { indexing: srcOwnIndexing } } : {}),
  });
}

/**
 * Copy a folder subtree. Refuses above {@link COPY_MAX_FILES} files — every
 * copy re-extracts under the destination's indexing mode, so a large copy is
 * a spend decision the caller must make deliberately (split it, or flag the
 * destination name-only first, which makes the whole copy LLM-free).
 */
export async function copyFolderById(args: {
  ownerId: string;
  folderId: string;
  destParentPath: string;
}): Promise<{ folder: FolderRow; copiedFiles: number; copiedFolders: number }> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.folderId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'branch') {
    throw new Error('copyFolderById: folder not found — find the id with folder_list');
  }
  if (node.path === FILES_ROOT_LABEL) throw new Error('copyFolderById: cannot copy the files root');
  const destParent = await branchAt(args.ownerId, args.destParentPath);
  if (!destParent) {
    throw new Error(
      `copyFolderById: no folder at '${args.destParentPath}' — create it with folder_create first`,
    );
  }
  if (args.destParentPath === node.path || args.destParentPath.startsWith(`${node.path}.`)) {
    throw new Error(
      `copyFolderById: cannot copy '${node.path}' into its own subtree ('${args.destParentPath}')`,
    );
  }
  const label = node.path.split('.').at(-1)!;
  if (await branchAt(args.ownerId, `${args.destParentPath}.${label}`)) {
    throw new Error(
      `copyFolderById: a folder named '${label}' already exists under '${args.destParentPath}' — rename one of them first`,
    );
  }

  const subtree = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, args.ownerId), sql`${nodes.path} <@ ${node.path}::ltree`))
    // nlevel asc puts parents before deeper children — but a FILE's path IS
    // its parent folder's path (same nlevel), so at a tie the branch must
    // come first or the file copies into a folder that doesn't exist yet
    // ('branch' < 'file' happens to sort right; stated explicitly so nobody
    // "simplifies" it away).
    .orderBy(sql`nlevel(${nodes.path}) asc`, sql`${nodes.type} asc`);
  const fileCount = subtree.filter((n) => n.type === 'file').length;
  if (fileCount > COPY_MAX_FILES) {
    throw new Error(
      `copyFolderById: '${node.path}' holds ${fileCount} files (cap ${COPY_MAX_FILES}) — copy subfolders individually, or flag the destination name-only first if you don't need the copies content-indexed`,
    );
  }

  // Parents before children (nlevel asc), so every folder exists before
  // anything lands inside it. Sequential on purpose: each file copy is a
  // disk write + an ingest notify; a folder copy should feel like a queue,
  // not a stampede.
  const prefix = node.path;
  const destOf = (p: string) => `${args.destParentPath}.${label}${p.slice(prefix.length)}`;
  let copiedFolders = 0;
  let copiedFiles = 0;
  let newRootId: string | null = null;
  for (const n of subtree) {
    if (n.type === 'branch') {
      const destPath = destOf(n.path);
      const parentPath = destPath.split('.').slice(0, -1).join('.');
      const nData = (n.data ?? {}) as Record<string, unknown>;
      const created = await createFolder({
        ownerId: args.ownerId,
        parentPath,
        slug: destPath.split('.').at(-1)!,
        description: typeof nData.description === 'string' ? nData.description : undefined,
      });
      // Carry the folder's OWN indexing flag so the copy of a name-only
      // gallery is still a name-only gallery — set BEFORE its files copy in,
      // so their ingest resolves the right effective mode from the start.
      if (nData.indexing === 'metadata' || nData.indexing === 'full') {
        await db
          .update(nodes)
          .set({
            data: sql`${nodes.data} || ${JSON.stringify({ indexing: nData.indexing })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(nodes.id, created.id));
      }
      if (n.id === node.id) newRootId = created.id;
      copiedFolders++;
    } else if (n.type === 'file') {
      await copyFileById({ ownerId: args.ownerId, fileId: n.id, destPath: destOf(n.path) });
      copiedFiles++;
    }
  }

  const folder = await folderById({ ownerId: args.ownerId, folderId: newRootId! });
  return { folder: folder!, copiedFiles, copiedFolders };
}
