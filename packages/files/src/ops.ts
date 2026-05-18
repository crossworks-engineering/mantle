/**
 * Files surface: the high-level operations that the API routes, the
 * MCP tools, and the future folder watcher all go through. Pairs every
 * DB mutation with the matching filesystem write so the two stay in
 * lockstep.
 *
 * Tree model:
 *   - `files` is the root ltree label and the only one we mirror to disk.
 *   - Folders are `nodes.type='branch'` rows. `data.description` is free
 *     text; `data.slug` is the kebab disk-name (because ltree labels
 *     can't carry a dash).
 *   - Files are `nodes.type='file'` rows. `data.filename` carries the
 *     lowercase basename; `data.content` is populated for text files
 *     so the extractor / editor don't need a disk round-trip.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  dashToLtree,
  diskPathForFile,
  diskPathForLtree,
  ensureDir,
  ensureRoot,
  extOf,
  FILES_ROOT_LABEL,
  filesRoot,
  isFilesPath,
  ltreeToDash,
  mimeForExt,
  removeFolder as removeFolderOnDisk,
  renameFile as renameFileOnDisk,
  sanitizeFilename,
  slugifyFolder,
  TEXT_EXTS,
  writeFile as writeFileOnDisk,
  deleteFile as deleteFileOnDisk,
} from './index.js';
import { db, nodes, type Node } from '@mantle/db';

export type FolderRow = {
  id: string;
  /** ltree string, e.g. 'files.work.lister-printer'. */
  path: string;
  title: string;
  slug: string;
  description: string;
  childFolderCount: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
};

export type FileRow = {
  id: string;
  parentPath: string;
  title: string;
  filename: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  isText: boolean;
  /** Indexed/embedded by the extractor when true. */
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

// ─── Root branch bootstrap ──────────────────────────────────────────────

/**
 * The `files` root branch must exist before any folder under it can be
 * created. Lazy-creates the row + the on-disk directory on first call.
 */
export async function ensureFilesRootBranch(ownerId: string): Promise<Node> {
  const existing = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${FILES_ROOT_LABEL}`,
      ),
    )
    .limit(1);
  if (existing[0]) {
    await ensureRoot();
    return existing[0];
  }
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Files',
      slug: FILES_ROOT_LABEL,
      path: FILES_ROOT_LABEL,
      data: {
        description: 'Host-mirrored filesystem. Folders and files here live on disk under MANTLE_FILES_ROOT.',
      },
      tags: ['files-root'],
    })
    .returning();
  if (!row) throw new Error('ensureFilesRootBranch: insert failed');
  await ensureRoot();
  return row;
}

// ─── Folder ops ─────────────────────────────────────────────────────────

/**
 * Create a folder under `parentPath` with the given disk slug + description.
 * Throws if the parent isn't a host-mirrored branch or the slug collides.
 */
export async function createFolder(args: {
  ownerId: string;
  parentPath: string;
  slug: string;
  description?: string;
}): Promise<FolderRow> {
  if (!isFilesPath(args.parentPath)) {
    throw new Error(`createFolder: parent '${args.parentPath}' is outside the files root`);
  }
  const slug = slugifyFolder(args.slug);
  if (!slug) {
    throw new Error(`createFolder: invalid slug '${args.slug}'`);
  }
  const childLabel = dashToLtree(slug);
  const childPath = `${args.parentPath}.${childLabel}`;

  // Make sure parent ltree node exists (when parent is `files`, the
  // lazy root-creation handles it; deeper parents must already exist).
  const [parent] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${args.parentPath}`,
      ),
    )
    .limit(1);
  if (!parent) {
    throw new Error(`createFolder: parent folder '${args.parentPath}' not found`);
  }

  // DB first — if the unique index trips, we don't want a leftover dir
  // confusing the next attempt.
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId: args.ownerId,
      type: 'branch',
      title: slug,
      slug,
      path: childPath,
      data: {
        description: args.description ?? '',
      },
      tags: [],
    })
    .returning();
  if (!row) throw new Error('createFolder: insert returned no row');

  await ensureDir(childPath);

  return folderRowFromNode(row, 0, 0);
}

export async function updateFolderDescription(args: {
  ownerId: string;
  folderId: string;
  description: string;
}): Promise<FolderRow | null> {
  const [existing] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.folderId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!existing || existing.type !== 'branch') return null;
  const data = (existing.data ?? {}) as Record<string, unknown>;
  const [row] = await db
    .update(nodes)
    .set({
      data: { ...data, description: args.description },
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, args.folderId))
    .returning();
  if (!row) return null;
  const counts = await folderCounts(args.ownerId, row.path);
  return folderRowFromNode(row, counts.childFolderCount, counts.fileCount);
}

/**
 * Delete a folder. Refuses if it still has children (folders or files)
 * so the operator has to do it bottom-up — guards against accidental
 * mass-delete via a single click.
 */
export async function deleteFolder(args: {
  ownerId: string;
  folderId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [folder] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.folderId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!folder || folder.type !== 'branch') {
    return { ok: false, reason: 'not-found' };
  }
  if (folder.path === FILES_ROOT_LABEL) {
    return { ok: false, reason: 'cannot delete the files root' };
  }
  const counts = await folderCounts(args.ownerId, folder.path);
  if (counts.childFolderCount > 0 || counts.fileCount > 0) {
    return { ok: false, reason: 'folder is not empty — delete its contents first' };
  }
  await db.delete(nodes).where(eq(nodes.id, args.folderId));
  await removeFolderOnDisk(folder.path);
  return { ok: true };
}

export async function listFolders(args: {
  ownerId: string;
  parentPath: string;
}): Promise<FolderRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        // Direct children only — nlevel = parent_level + 1 and prefix match.
        sql`${nodes.path} ~ ${`${args.parentPath}.*{1}`}::lquery`,
      ),
    );
  // Add counts per row.
  const results: FolderRow[] = [];
  for (const row of rows) {
    const counts = await folderCounts(args.ownerId, row.path);
    results.push(folderRowFromNode(row, counts.childFolderCount, counts.fileCount));
  }
  results.sort((a, b) => a.slug.localeCompare(b.slug));
  return results;
}

/** All descendant folders, used to build the tree rail in one query. */
export async function listAllFolders(ownerId: string): Promise<FolderRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path} <@ ${FILES_ROOT_LABEL}::ltree`,
      ),
    );
  const out: FolderRow[] = [];
  for (const row of rows) {
    const counts = await folderCounts(ownerId, row.path);
    out.push(folderRowFromNode(row, counts.childFolderCount, counts.fileCount));
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function folderCounts(
  ownerId: string,
  parentPath: string,
): Promise<{ childFolderCount: number; fileCount: number }> {
  const [folderCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path} ~ ${`${parentPath}.*{1}`}::lquery`,
      ),
    );
  const [fileCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${parentPath}`,
      ),
    );
  return {
    childFolderCount: folderCountRow?.n ?? 0,
    fileCount: fileCountRow?.n ?? 0,
  };
}

function folderRowFromNode(row: Node, childFolderCount: number, fileCount: number): FolderRow {
  const data = (row.data ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    slug: typeof data.slug === 'string' ? (data.slug as string) : row.slug ?? row.title,
    description: typeof data.description === 'string' ? (data.description as string) : '',
    childFolderCount,
    fileCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── File ops ───────────────────────────────────────────────────────────

const TEXT_BYTE_CAP = 1_000_000; // 1 MB cap for content-in-DB caching.

/**
 * Create or replace a file under `parentPath`. Writes bytes to disk and
 * inserts/updates the `nodes` row; for text files (extension in
 * TEXT_EXTS) the content is also stashed in `data.content` so the
 * extractor / editor can skip the disk round-trip.
 *
 * For new uploads pass `overwrite=false`; for in-place edits pass true.
 */
export async function upsertFile(args: {
  ownerId: string;
  parentPath: string;
  filename: string;
  bytes: Buffer;
  overwrite?: boolean;
}): Promise<FileRow> {
  if (!isFilesPath(args.parentPath)) {
    throw new Error(`upsertFile: parent '${args.parentPath}' is outside the files root`);
  }
  const filename = sanitizeFilename(args.filename);
  if (!filename) {
    throw new Error(`upsertFile: invalid filename '${args.filename}'`);
  }
  const ext = extOf(filename);
  const mime = mimeForExt(ext);
  const isText = TEXT_EXTS.has(ext);

  // Make sure parent branch exists in the DB.
  const [parent] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${args.parentPath}`,
      ),
    )
    .limit(1);
  if (!parent) {
    throw new Error(`upsertFile: parent folder '${args.parentPath}' not found`);
  }

  // Disk write first; if it fails, we never insert orphan DB rows.
  const written = await writeFileOnDisk(args.parentPath, filename, args.bytes, {
    overwrite: args.overwrite,
  });

  const content = isText && args.bytes.byteLength <= TEXT_BYTE_CAP
    ? args.bytes.toString('utf8')
    : null;

  // Look for an existing row (case where overwrite=true).
  const [existing] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${args.parentPath}`,
        sql`${nodes.data}->>'filename' = ${filename}`,
      ),
    )
    .limit(1);

  const newData: Record<string, unknown> = {
    filename,
    extension: ext,
    mime_type: mime,
    size_bytes: written.size,
    sha256: written.sha256,
    ...(content != null ? { content } : {}),
  };

  let row: Node;
  if (existing) {
    const oldData = (existing.data ?? {}) as Record<string, unknown>;
    // Preserve summary / entities from the extractor across edits unless
    // the content changed — in which case we clear them so the next
    // extractor run gets a fresh shot.
    const sameContent = oldData.sha256 === written.sha256;
    const preserved = sameContent
      ? {
          summary: oldData.summary,
          summary_model: oldData.summary_model,
          summary_at: oldData.summary_at,
          entities: oldData.entities,
        }
      : {};
    const [updated] = await db
      .update(nodes)
      .set({
        title: filename,
        data: { ...preserved, ...newData },
        updatedAt: new Date(),
        ...(sameContent ? {} : { embedding: null }),
      })
      .where(eq(nodes.id, existing.id))
      .returning();
    if (!updated) throw new Error('upsertFile: update returned no row');
    row = updated;
    // Notify the extractor again only when content changed.
    if (!sameContent) {
      await db.execute(sql`SELECT pg_notify('node_ingested', ${updated.id}::text)`);
    }
  } else {
    const [inserted] = await db
      .insert(nodes)
      .values({
        ownerId: args.ownerId,
        type: 'file',
        title: filename,
        slug: filename,
        path: args.parentPath,
        data: newData,
        tags: ['file'],
      })
      .returning();
    if (!inserted) throw new Error('upsertFile: insert returned no row');
    row = inserted;
    // pg_notify('node_ingested') is fired by migration 0018's trigger;
    // no explicit notify needed for fresh inserts.
  }

  return fileRowFromNode(row);
}

export async function readFileById(args: {
  ownerId: string;
  fileId: string;
}): Promise<{ row: FileRow; bytes: Buffer; path: string } | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') return null;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = String(data.filename ?? '');
  const filePath = diskPathForFile(node.path, filename);
  if (!filePath) return null;
  // Prefer cached content for text files to avoid disk reads in the
  // hot path; fall back to disk for binaries.
  let bytes: Buffer;
  if (typeof data.content === 'string') {
    bytes = Buffer.from(data.content as string, 'utf8');
  } else {
    const { promises: fs } = await import('node:fs');
    bytes = await fs.readFile(filePath);
  }
  return { row: fileRowFromNode(node), bytes, path: filePath };
}

export async function deleteFileById(args: {
  ownerId: string;
  fileId: string;
}): Promise<{ ok: boolean }> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') return { ok: false };
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = String(data.filename ?? '');
  await db.delete(nodes).where(eq(nodes.id, node.id));
  if (filename) await deleteFileOnDisk(node.path, filename);
  return { ok: true };
}

export async function renameFileById(args: {
  ownerId: string;
  fileId: string;
  /** New basename WITHOUT the extension. Extension is preserved. */
  newStem: string;
}): Promise<FileRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') return null;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const oldFilename = String(data.filename ?? '');
  const ext = String(data.extension ?? extOf(oldFilename));
  const sanitisedStem = sanitizeFilename(`${args.newStem}.${ext}`);
  if (!sanitisedStem) return null;
  const newFilename = sanitisedStem;
  if (newFilename === oldFilename) return fileRowFromNode(node);
  await renameFileOnDisk(node.path, oldFilename, newFilename);
  const [updated] = await db
    .update(nodes)
    .set({
      title: newFilename,
      slug: newFilename,
      data: { ...data, filename: newFilename },
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, node.id))
    .returning();
  return updated ? fileRowFromNode(updated) : null;
}

export async function bulkDeleteFiles(args: {
  ownerId: string;
  fileIds: string[];
}): Promise<{ deleted: number }> {
  let deleted = 0;
  for (const id of args.fileIds) {
    const res = await deleteFileById({ ownerId: args.ownerId, fileId: id });
    if (res.ok) deleted++;
  }
  return { deleted };
}

export async function listFiles(args: {
  ownerId: string;
  parentPath: string;
}): Promise<FileRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${args.parentPath}`,
      ),
    );
  return rows.map(fileRowFromNode).sort((a, b) => a.filename.localeCompare(b.filename));
}

function fileRowFromNode(row: Node): FileRow {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const filename = String(data.filename ?? row.title);
  const ext = String(data.extension ?? extOf(filename));
  return {
    id: row.id,
    parentPath: row.path,
    title: row.title,
    filename,
    extension: ext,
    mimeType: typeof data.mime_type === 'string' ? (data.mime_type as string) : mimeForExt(ext),
    sizeBytes: Number(data.size_bytes ?? 0),
    sha256: typeof data.sha256 === 'string' ? (data.sha256 as string) : null,
    isText: TEXT_EXTS.has(ext),
    summary: typeof data.summary === 'string' ? (data.summary as string) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Lookup helpers ─────────────────────────────────────────────────────

export async function folderById(args: {
  ownerId: string;
  folderId: string;
}): Promise<FolderRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.folderId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!row || row.type !== 'branch') return null;
  const counts = await folderCounts(args.ownerId, row.path);
  return folderRowFromNode(row, counts.childFolderCount, counts.fileCount);
}

export async function folderByPath(args: {
  ownerId: string;
  path: string;
}): Promise<FolderRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${args.path}`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const counts = await folderCounts(args.ownerId, row.path);
  return folderRowFromNode(row, counts.childFolderCount, counts.fileCount);
}

export async function fileById(args: {
  ownerId: string;
  fileId: string;
}): Promise<FileRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!row || row.type !== 'file') return null;
  return fileRowFromNode(row);
}

// Suppress unused-import noise.
void filesRoot;
void ltreeToDash;
void isNull;
void diskPathForLtree;
