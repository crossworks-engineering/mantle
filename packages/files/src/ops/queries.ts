/**
 * Read-only lookups over folders and files.
 *
 * Split out of ops.ts; bodies moved verbatim.
 */

import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { diskPathForLtree, filesRoot, ltreeToDash } from '../index';
import { type ExtractionState } from '../extraction-status';
import { emailAttachmentIds } from '../email-attachments';
import { keyWithoutSearch } from '../file-data';
import { withVersions } from '../file-history';
import { db, nodes, READ_FAILURE_SKIPS, type Node } from '@mantle/db';
import {
  fileRowFromNode,
  folderCounts,
  folderRowFromNode,
  type FileRow,
  type FolderRow,
} from './shared';

/** The most rows `listFilesByExtraction` reads before it filters. */
export const EXTRACTION_LIST_MAX = 500;

/** The keys a file in each state holds, as SQL: a cheap first cut, which
 *  `extractionOf` (the one rule) then settles row by row. Built at the call,
 *  not at import: a test that mocks @mantle/db loads this module too. */
function extractionCut(state: ExtractionState): ReturnType<typeof sql> {
  const failedReason = sql`${nodes.data}->'extract_skipped'->>'reason' in (${sql.join(
    READ_FAILURE_SKIPS.map((r) => sql`${r}`),
    sql`, `,
  )})`;
  switch (state) {
    case 'failed':
      return sql`(${failedReason} or ${nodes.data} ? 'extract_parked')`;
    case 'skipped':
      return sql`(${nodes.data} ? 'extract_skipped' and not ${failedReason})`;
    case 'partial':
      return sql`jsonb_typeof(${nodes.data}->'ocr') = 'object'`;
    case 'pending':
      return sql`not (${nodes.data} ?| array['extract_completed_at', 'extract_skipped', 'extract_parked']) and coalesce(${nodes.data}->>'indexing_applied', '') <> 'metadata'`;
    case 'indexed':
      return sql`${nodes.data} ? 'extract_completed_at'`;
    case 'name_only':
      return sql`${nodes.data}->>'indexing_applied' = 'metadata'`;
  }
}

/** A file row with no vector, and its data without the long text the
 *  listing never shows (up to 1 M characters each). */
function listSelect() {
  const { embedding: _embedding, ...columns } = getTableColumns(nodes);
  return {
    ...columns,
    data: sql<unknown>`${nodes.data} - 'text' - 'agent_text' - 'entities'`.as('data'),
  };
}

/**
 * The files in one extraction state (failed, partial, ...), in the whole
 * tree or under `under` (an ltree path), newest first, read in the caller's
 * scope. Reads at most EXTRACTION_LIST_MAX candidate rows; `truncated` says
 * the cut was reached. The answer is an object, which the key email guard
 * does not filter, so an API key without the Search area loses the email
 * attachment rows here (as listDataFiles does).
 */
export async function listFilesByExtraction(args: {
  ownerId: string;
  state: ExtractionState;
  under?: string;
}): Promise<{ files: FileRow[]; truncated: boolean }> {
  const rows = await db
    .select(listSelect())
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        isNull(nodes.supersededBy),
        args.under ? sql`${nodes.path} <@ ${args.under}::ltree` : undefined,
        extractionCut(args.state),
      ),
    )
    .orderBy(sql`${nodes.updatedAt} desc`)
    .limit(EXTRACTION_LIST_MAX);
  let files = rows
    .map((r) => fileRowFromNode(r as unknown as Node))
    .filter((f) => f.extraction.state === args.state);
  if (keyWithoutSearch() && files.length > 0) {
    const hidden = await emailAttachmentIds(
      args.ownerId,
      files.map((f) => f.id),
    );
    files = files.filter((f) => !hidden.has(f.id));
  }
  return { files: await withVersions(files), truncated: rows.length >= EXTRACTION_LIST_MAX };
}

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
  return withVersions(rows.map(fileRowFromNode));
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
  return withVersions(
    rows.map(fileRowFromNode).sort((a, b) => a.filename.localeCompare(b.filename)),
  );
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
  return (await withVersions([fileRowFromNode(row)]))[0]!;
}

/** The files among `ids` the caller reads (its scope's row rules decide),
 *  in no order: an id that is not a file, or one the caller cannot read, is
 *  left out. */
export async function filesByIds(args: {
  ownerId: string;
  ids: readonly string[];
}): Promise<FileRow[]> {
  if (!args.ids.length) return [];
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.id} = any (${`{${args.ids.join(',')}}`}::uuid[])`,
      ),
    );
  return rows.map(fileRowFromNode);
}

// Suppress unused-import noise.
void filesRoot;
void ltreeToDash;
void isNull;
void diskPathForLtree;
