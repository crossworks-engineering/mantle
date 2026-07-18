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
  renameFolder as renameFolderOnDisk,
  sanitizeFilename,
  slugifyFolder,
  TEXT_EXTS,
  writeFile as writeFileOnDisk,
  deleteFile as deleteFileOnDisk,
} from './index';
import {
  db,
  emailAttachments,
  forumUploads,
  nodes,
  notifyNodeIngested,
  type Node,
} from '@mantle/db';

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
        description:
          'Host-mirrored filesystem. Folders and files here live on disk under MANTLE_FILES_ROOT.',
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

/**
 * Ensure `files.<topSlug>.<YYYY-MM-DD>` exists (both levels) and return the
 * per-day folder's ltree path. The upload surfaces (web /assistant, Telegram)
 * use this to file an incoming image under a dated folder before persisting
 * the bytes. Idempotent — tolerates the unique-index race when two uploads
 * land in the same second. Note ltree labels use underscores, so the stored
 * path uses `dashToLtree(slug)` while `createFolder` keeps the dash slug as
 * the disk dir name (mirrors the original per-surface helpers).
 */
export async function ensureDatedUploadFolder(args: {
  ownerId: string;
  topSlug: string;
  topDescription?: string;
}): Promise<string> {
  const { ownerId, topSlug } = args;
  const topLtree = `files.${dashToLtree(topSlug)}`;
  const dateSlug = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  for (const [parent, slug, description] of [
    ['files', topSlug, args.topDescription ?? ''],
    [topLtree, dateSlug, `Uploads from ${dateSlug}.`],
  ] as const) {
    const childPath = `${parent}.${dashToLtree(slug)}`;
    const [exists] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'branch'),
          sql`${nodes.path}::text = ${childPath}`,
        ),
      )
      .limit(1);
    if (!exists) {
      try {
        await createFolder({ ownerId, parentPath: parent, slug, description });
      } catch (err) {
        if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
      }
    }
  }
  return `${topLtree}.${dashToLtree(dateSlug)}`;
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
    slug: typeof data.slug === 'string' ? (data.slug as string) : (row.slug ?? row.title),
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

  // Look up any existing DB row for this (folder, filename) BEFORE touching
  // disk, so we can tell a real duplicate from an orphaned disk file.
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

  // Disk write. The "already exists" collision is only meaningful when a real
  // DB node owns the name. A disk file with NO node is orphan residue from an
  // interrupted upload (the disk write landed but the node insert never ran) —
  // adopt it by overwriting, so a re-upload self-heals instead of being stuck
  // forever on "already exists" with nothing in the UI to delete.
  const effectiveOverwrite = args.overwrite || !existing;
  const written = await writeFileOnDisk(args.parentPath, filename, args.bytes, {
    overwrite: effectiveOverwrite,
  });

  const content =
    isText && args.bytes.byteLength <= TEXT_BYTE_CAP ? args.bytes.toString('utf8') : null;

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
      await notifyNodeIngested(updated.id);
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
    try {
      bytes = await fs.readFile(filePath);
    } catch (err) {
      // Node exists but its disk bytes are gone (host-mirrored tree edited
      // out-of-band, or a half-completed delete): treat as not-found so
      // callers 404 cleanly instead of a bare ENOENT bubbling to a 500.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  return { row: fileRowFromNode(node), bytes, path: filePath };
}

export async function deleteFileById(args: {
  ownerId: string;
  fileId: string;
}): Promise<{ ok: boolean; reason?: 'not_found' | 'attachment' }> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.fileId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'file') return { ok: false, reason: 'not_found' };
  // Block deletion of a file that's an email attachment: email_attachments
  // .file_node_id is ON DELETE RESTRICT, so a bare delete would raise an FK
  // violation and surface as a 500. Return a clean refusal the caller can show
  // instead — the bytes are owned by the email; delete it from there.
  const [attachment] = await db
    .select({ id: emailAttachments.id })
    .from(emailAttachments)
    .where(eq(emailAttachments.fileNodeId, node.id))
    .limit(1);
  if (attachment) return { ok: false, reason: 'attachment' };
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = String(data.filename ?? '');
  await db.delete(nodes).where(eq(nodes.id, node.id));
  if (filename) await deleteFileOnDisk(node.path, filename);
  // A filed forum upload points here by node_id (no FK — the node is a
  // derived artifact). Clear the pointer so its member serve route 404s
  // cleanly instead of chasing a deleted node. Cheap and almost always a
  // no-op (only file nodes filed from the forum review ever match).
  await db
    .update(forumUploads)
    .set({ nodeId: null })
    .where(and(eq(forumUploads.ownerId, args.ownerId), eq(forumUploads.nodeId, node.id)));
  return { ok: true };
}

/**
 * Sync a file the watcher just observed on disk into the DB without
 * re-writing it. Differs from `upsertFile` in two ways:
 *
 *   1. Bytes are NOT written back to disk — they're already there.
 *      Calling `upsertFile` would trigger another change event and
 *      we'd loop forever.
 *   2. If the DB row already has the same sha256, we no-op. This
 *      catches editor-save-twice and our own UI writes (which set
 *      sha256 before chokidar even reports the change).
 *
 * Returns 'noop' | 'inserted' | 'updated' so the watcher can log.
 */
export async function syncFileFromDisk(args: {
  ownerId: string;
  parentPath: string;
  filename: string;
  bytes: Buffer;
}): Promise<{ status: 'noop' | 'inserted' | 'updated'; nodeId: string | null }> {
  if (!isFilesPath(args.parentPath)) {
    throw new Error(`syncFileFromDisk: parent '${args.parentPath}' is outside the files root`);
  }
  const filename = sanitizeFilename(args.filename);
  if (!filename) {
    throw new Error(`syncFileFromDisk: invalid filename '${args.filename}'`);
  }
  // Compute hash locally; no disk write.
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(args.bytes).digest('hex');
  const ext = extOf(filename);
  const mime = mimeForExt(ext);
  const isText = TEXT_EXTS.has(ext);

  // Make sure the parent folder exists in the DB. If chokidar saw a
  // file under a directory we don't know about, lazy-create the
  // branch chain. The watcher caller is the one in charge of
  // mirroring whole subtrees consistently.
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
    await ensureBranchChain(args.ownerId, args.parentPath);
  }

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

  const content =
    isText && args.bytes.byteLength <= TEXT_BYTE_CAP ? args.bytes.toString('utf8') : null;

  const newData: Record<string, unknown> = {
    filename,
    extension: ext,
    mime_type: mime,
    size_bytes: args.bytes.byteLength,
    sha256,
    ...(content != null ? { content } : {}),
  };

  if (existing) {
    const oldData = (existing.data ?? {}) as Record<string, unknown>;
    // Same bytes? Watcher fired but nothing changed — likely an
    // atime tick or our own UI write that already populated the row.
    if (oldData.sha256 === sha256) {
      return { status: 'noop', nodeId: existing.id };
    }
    const [updated] = await db
      .update(nodes)
      .set({
        title: filename,
        data: { ...newData },
        updatedAt: new Date(),
        embedding: null,
      })
      .where(eq(nodes.id, existing.id))
      .returning({ id: nodes.id });
    if (!updated) throw new Error('syncFileFromDisk: update returned no row');
    await notifyNodeIngested(updated.id);
    return { status: 'updated', nodeId: updated.id };
  }
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
    .returning({ id: nodes.id });
  if (!inserted) throw new Error('syncFileFromDisk: insert returned no row');
  return { status: 'inserted', nodeId: inserted.id };
}

/** Delete a file row by its on-disk coordinates. Used by the watcher
 *  when a file disappears from disk. */
export async function deleteFileByPath(args: {
  ownerId: string;
  parentPath: string;
  filename: string;
}): Promise<{ ok: boolean }> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${args.parentPath}`,
        sql`${nodes.data}->>'filename' = ${args.filename}`,
      ),
    )
    .limit(1);
  if (!node) return { ok: false };
  await db.delete(nodes).where(eq(nodes.id, node.id));
  return { ok: true };
}

/** Lazy-mkdir for an arbitrary ltree path under `files.*`. Inserts a
 *  branch node for every missing label so the watcher can pick up files
 *  created in folders the UI hasn't seen yet. */
async function ensureBranchChain(ownerId: string, ltreePath: string): Promise<void> {
  if (!isFilesPath(ltreePath)) return;
  const segments = ltreePath.split('.');
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    const label = segments[i - 1]!;
    const slug = label.replace(/_/g, '-');
    await db
      .insert(nodes)
      .values({
        ownerId,
        type: 'branch',
        title: slug,
        slug,
        path: prefix,
        data: { description: '', slug },
      })
      .onConflictDoNothing({
        target: [nodes.ownerId, nodes.path],
        where: sql`${nodes.type} = 'branch'`,
      });
  }
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

/** Swap the LAST label of an ltree path for `newLabel`, keeping the parent
 *  prefix. Pure (no DB/disk) so the path math is unit-testable. The root
 *  `files` (no dot) returns just `newLabel`, but callers reject renaming root. */
export function renamedFolderPath(oldPath: string, newLabel: string): string {
  const dot = oldPath.lastIndexOf('.');
  return dot === -1 ? newLabel : `${oldPath.slice(0, dot)}.${newLabel}`;
}

/**
 * Rename a folder in place (same parent, new label). Rewrites the ltree path
 * of the folder AND every descendant — folders and files alike, since a file's
 * `path` IS its parent folder's path — in one cascade, and renames the matching
 * directory on disk (the whole subtree moves with it). Throws on the root, an
 * invalid name, or a name collision. Returns null only when the id isn't a
 * folder the owner has.
 */
export async function renameFolderById(args: {
  ownerId: string;
  folderId: string;
  /** New display name; slugified the same way createFolder does. */
  newSlug: string;
}): Promise<FolderRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.folderId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'branch') return null;
  if (node.path === FILES_ROOT_LABEL) {
    throw new Error('renameFolderById: cannot rename the files root');
  }
  const slug = slugifyFolder(args.newSlug);
  if (!slug) throw new Error(`renameFolderById: invalid name '${args.newSlug}'`);
  const newLabel = dashToLtree(slug);
  const oldPath = node.path;
  const newPath = renamedFolderPath(oldPath, newLabel);
  if (newPath === oldPath) {
    const counts = await folderCounts(args.ownerId, oldPath);
    return folderRowFromNode(node, counts.childFolderCount, counts.fileCount);
  }

  // Collision: another branch already at the target path. The
  // nodes_branch_owner_path_uq index also enforces this; we check first for a
  // clean error rather than a constraint-violation string.
  const [clash] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${newPath}`,
      ),
    )
    .limit(1);
  if (clash) {
    throw new Error(`renameFolderById: a folder named '${slug}' already exists here`);
  }

  // Disk first (atomic fs.rename of the directory), then the DB cascade in a
  // transaction. If the DB write fails, put the directory back so disk and DB
  // never diverge.
  await renameFolderOnDisk(oldPath, newPath);
  try {
    await db.transaction(async (tx) => {
      // Rewrite the prefix for the folder itself + every descendant (folders and
      // files — a file's path IS its parent folder's path). The folder itself is
      // handled by the CASE: `subpath(path, nlevel(oldPath))` would throw
      // "invalid positions" when offset == nlevel (the self row), so map it to
      // newPath directly; descendants keep their tail under the new prefix.
      await tx.execute(sql`
        UPDATE ${nodes}
        SET path = CASE
              WHEN path = ${oldPath}::ltree THEN text2ltree(${newPath})
              ELSE (text2ltree(${newPath}) || subpath(path, nlevel(${oldPath}::ltree)))::ltree
            END,
            updated_at = now()
        WHERE owner_id = ${args.ownerId} AND path <@ ${oldPath}::ltree
      `);
      // The folder's own label fields (path already rewritten above).
      const data = (node.data ?? {}) as Record<string, unknown>;
      await tx
        .update(nodes)
        .set({ title: slug, slug, data: { ...data, slug }, updatedAt: new Date() })
        .where(eq(nodes.id, node.id));
    });
  } catch (err) {
    await renameFolderOnDisk(newPath, oldPath).catch(() => {});
    throw err;
  }
  return folderById({ ownerId: args.ownerId, folderId: args.folderId });
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

export async function listFiles(args: { ownerId: string; parentPath: string }): Promise<FileRow[]> {
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

export async function fileById(args: { ownerId: string; fileId: string }): Promise<FileRow | null> {
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
