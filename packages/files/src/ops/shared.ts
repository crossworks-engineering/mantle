/**
 * Shared row shapes, the files-root branch, and the node→row mappers.
 * Every other ops module builds on these; this module imports none of them.
 *
 * Split out of ops.ts; bodies moved verbatim.
 */

import { and, eq, sql } from 'drizzle-orm';
import { ensureRoot, extOf, FILES_ROOT_LABEL, mimeForExt, TEXT_EXTS } from '../index';
import { db, nodes, type Node } from '@mantle/db';

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
  /** The file's OWN data.indexing flag; null = inherit (folder chain decides). */
  indexing: 'full' | 'metadata' | null;
  /** Which mode the extractor LAST ran for this file ('metadata' spine vs full
   *  content). Null until first extraction. What a listing should badge. */
  indexingApplied: 'full' | 'metadata' | null;
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
  // Concurrent first-uploads race this create-if-missing (two requests can
  // both see "missing" and insert) — the nodes_branch_owner_path_uq constraint
  // is the arbiter, so swallow the loser's 23505 and re-read the winner's row.
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
    .onConflictDoNothing()
    .returning();
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
    childFolderCount,
    fileCount,
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Lookup helpers ─────────────────────────────────────────────────────
