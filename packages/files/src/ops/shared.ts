/**
 * Shared row shapes, the files-root branch, and the node→row mappers.
 * Every other ops module builds on these; this module imports none of them.
 *
 * Split out of ops.ts; bodies moved verbatim.
 */

import { and, eq, sql } from 'drizzle-orm';
import { ensureRoot, extOf, FILES_ROOT_LABEL, mimeForExt, TEXT_EXTS } from '../index';
import {
  asViewerLevel,
  db,
  isWriteRefused,
  type Node,
  nodes,
  type ViewerLevel,
  withDeadlockRetry,
  withNodeInsertHeads,
} from '@mantle/db';

export type FolderRow = {
  id: string;
  /** ltree string, e.g. 'files.work.lister-printer'. */
  path: string;
  title: string;
  slug: string;
  description: string;
  /** The folder's OWN data.indexing flag; null = inherit from ancestors.
   *  Effective resolution lives in ./indexing.ts (extract-time concern). */
  indexing: 'full' | 'metadata' | null;
  /** The folder's face in the Files tree: an emoji or a `lucide:<name>` key,
   *  and a named tint key (never a hex). Same vocabulary as an app's look
   *  (@mantle/client-types/app-nav); null = the default folder glyph. */
  icon: string | null;
  color: string | null;
  childFolderCount: number;
  fileCount: number;
  /** Access level (admin > team > client > public); the owner UI's badge. */
  audience: ViewerLevel;
  /** The folder's own share (team or client), or null. Everything below it
   *  is read at least at this level. */
  share: 'team' | 'client' | null;
  /** The share it inherits from a folder above it (team or client), or
   *  null. It is read at the more open of this and `audience`. */
  inherited: 'team' | 'client' | null;
  /** The share it is read at through something that embeds it (migration
   *  0208), or null. It is read at the most open of this, `inherited` and
   *  `audience`. */
  embedded: 'team' | 'client' | null;
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
  /** The file's OWN data.indexing flag; null = inherit (folder chain decides). */
  indexing: 'full' | 'metadata' | null;
  /** Which mode the extractor LAST ran for this file ('metadata' spine vs full
   *  content). Null until first extraction. What a listing should badge. */
  indexingApplied: 'full' | 'metadata' | null;
  /** Access level (admin > team > client > public); the owner UI's badge. */
  audience: ViewerLevel;
  /** The share it inherits from a folder above it (team or client), or
   *  null. It is read at the more open of this and `audience`. */
  inherited: 'team' | 'client' | null;
  /** The share it is read at through something that embeds it (migration
   *  0208), or null. It is read at the most open of this, `inherited` and
   *  `audience`. */
  embedded: 'team' | 'client' | null;
  createdAt: string;
  updatedAt: string;
};

// ─── Root branch bootstrap ──────────────────────────────────────────────

/**
 * The `files` root branch must exist before any folder under it can be
 * created. Lazy-creates the row + the on-disk directory on first call.
 *
 * Reads call this too (the Files lists, the tree), so it looks first and
 * writes only a missing root. Null when the root is missing and the database
 * refused to make it (a read-only replica, a role with SELECT only): the read
 * then finds no files, and a write that follows fails by itself.
 */
export async function ensureFilesRootBranch(ownerId: string): Promise<Node | null> {
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
  // Concurrent first-uploads race this create-if-missing (two requests can
  // both see "missing" and insert) — the nodes_branch_owner_path_uq constraint
  // is the arbiter, so swallow the loser's 23505 and re-read the winner's row.
  let row: Node | undefined;
  try {
    // Heads first (workspaces plan U1); a root has no folder above it.
    [row] = await withDeadlockRetry(() =>
      withNodeInsertHeads(ownerId, [{ type: 'branch', path: FILES_ROOT_LABEL }], (tx) =>
        tx
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
          .onConflictDoNothing()
          .returning(),
      ),
    );
  } catch (err) {
    // Narrow on purpose: only "the database refused to write". Anything else
    // is a real failure and must still surface.
    if (!isWriteRefused(err)) throw err;
    return null;
  }
  if (!row) {
    const [won] = await db
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
    if (!won) throw new Error('ensureFilesRootBranch: insert failed');
    await ensureRoot();
    return won;
  }
  await ensureRoot();
  return row;
}

export async function folderCounts(
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

export function folderRowFromNode(
  row: Node,
  childFolderCount: number,
  fileCount: number,
): FolderRow {
  const data = (row.data ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    slug: typeof data.slug === 'string' ? (data.slug as string) : (row.slug ?? row.title),
    description: typeof data.description === 'string' ? (data.description as string) : '',
    indexing: data.indexing === 'metadata' ? 'metadata' : data.indexing === 'full' ? 'full' : null,
    icon: typeof data.icon === 'string' && data.icon ? data.icon : null,
    color: typeof data.color === 'string' && data.color ? data.color : null,
    childFolderCount,
    fileCount,
    audience: asViewerLevel(row.audience),
    share: row.shareLevel === 'team' || row.shareLevel === 'client' ? row.shareLevel : null,
    inherited:
      row.inheritedLevel === 'team' || row.inheritedLevel === 'client' ? row.inheritedLevel : null,
    embedded:
      row.embeddedLevel === 'team' || row.embeddedLevel === 'client' ? row.embeddedLevel : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── File ops ───────────────────────────────────────────────────────────

export function fileRowFromNode(row: Node): FileRow {
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
    indexing: data.indexing === 'metadata' ? 'metadata' : data.indexing === 'full' ? 'full' : null,
    indexingApplied:
      data.indexing_applied === 'metadata'
        ? 'metadata'
        : data.indexing_applied === 'full'
          ? 'full'
          : null,
    audience: asViewerLevel(row.audience),
    inherited:
      row.inheritedLevel === 'team' || row.inheritedLevel === 'client' ? row.inheritedLevel : null,
    embedded:
      row.embeddedLevel === 'team' || row.embeddedLevel === 'client' ? row.embeddedLevel : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Lookup helpers ─────────────────────────────────────────────────────
