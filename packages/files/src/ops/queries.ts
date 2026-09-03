/**
 * Read-only lookups over folders and files.
 *
 * Split out of ops.ts; bodies moved verbatim.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { diskPathForLtree, filesRoot, ltreeToDash } from '../index';
import { db, nodes } from '@mantle/db';
import {
  fileRowFromNode,
  folderCounts,
  folderRowFromNode,
  type FileRow,
  type FolderRow,
} from './shared';

/**
 * The newest files across the WHOLE tree, most-recently-touched first.
 * Powers the left pane's "Recent" entry — the answer to "where did that
 * upload land", which per-folder listing can't give without a hunt. Ordered
 * by updated_at so an edit resurfaces a file the way a fresh upload does.
 */
export async function listRecentFiles(args: {
  ownerId: string;
  limit?: number;
}): Promise<FileRow[]> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, args.ownerId), eq(nodes.type, 'file'), isNull(nodes.supersededBy)))
    .orderBy(sql`${nodes.updatedAt} desc`)
    .limit(limit);
  return rows.map(fileRowFromNode);
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
