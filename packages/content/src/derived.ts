/**
 * Reap the nodes ingest derived from a file — the delete-side twin of the
 * spawn sites (embedded-image extraction, auto-imported spreadsheets, and the
 * *_from_file tools), all of which link back to their source only through
 * `data.sourceFileId` (JSONB, no FK).
 *
 * Application code, deliberately NOT a trigger: the reap must delete disk
 * artifacts (image bytes, table workbook files) that SQL cannot touch, and
 * the confirm flow needs a count-first preview a trigger cannot return. Each
 * kind routes through its own delete function so the cleanup that function
 * already encapsulates (workbook files for tables, disk bytes for images,
 * registry rows) happens exactly once; the 0058/0059 reaper triggers then
 * fire per reaped node. No LLM call anywhere on this path.
 *
 * Orchestration contract (see deleteFileById's has_derived refusal): callers
 * reap FIRST, then delete the source with `deleteDerived: true`. A mid-reap
 * failure therefore leaves the source file plus an audit-measurable count
 * (dangling_source_file at /debug/integrity), never silent orphans.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import {
  dashToLtree,
  deleteFileById,
  deleteFolder,
  derivedBucketForType,
  drawsReferencingFile,
  emptyDerivedCounts,
  EXTRACTED_IMAGES_SLUG,
  FILES_ROOT_LABEL,
  folderByPath,
  type DerivedCounts,
} from '@mantle/files';

import { deleteNote } from './notes';
import { deletePage } from './pages';
import { deleteTable } from './tables';

export { countDerivedFromFile, describeDerivedCounts, type DerivedCounts } from '@mantle/files';

/**
 * Is this ltree path a per-document extracted-images folder (a strict child
 * of `files.extracted_images`)? The reap may deleteFolder ONLY such a child,
 * never the shared extracted-images root — and deleteFolder itself still
 * refuses non-empty folders, so a folder holding anything the reap didn't
 * remove survives by construction.
 */
export function isPerDocumentExtractedImagesPath(path: string): boolean {
  const root = `${FILES_ROOT_LABEL}.${dashToLtree(EXTRACTED_IMAGES_SLUG)}`;
  return path.startsWith(`${root}.`) && path.length > root.length + 1;
}

export type ReapResult = {
  /** Nodes actually deleted, bucketed the same way as the count preview. */
  reaped: DerivedCounts;
  /** Nodes left in place — email-attachment refusals, a (never yet observed)
   *  grandchild-bearing image, or a per-node error. Skips stay visible in the
   *  dangling_source_file audit check rather than failing the whole reap. */
  skipped: number;
};

/**
 * Delete every node whose `data.sourceFileId` points at this file, one level
 * deep, best-effort per node. Extractor code guarantees derived nodes never
 * spawn grandchildren (an extracted image is never re-opened for images), but
 * the depth-one guard holds regardless: a derived file node that somehow HAS
 * its own derived nodes refuses deletion and counts as a skip.
 *
 * After the images go, the per-document `files.extracted-images.<doc-slug>`
 * folder is removed when (and only when) the reap emptied it.
 */
export async function reapDerivedFromFile(
  ownerId: string,
  fileId: string,
  options?: {
    /** Restrict the reap to these node types (e.g. ['file', 'table'] to keep
     *  pages and notes). Filtered-out nodes are simply not touched — they are
     *  neither reaped nor counted as skipped. Default: all types. */
    types?: readonly string[];
  },
): Promise<ReapResult> {
  const rows = await db
    .select({ id: nodes.id, type: sql<string>`${nodes.type}::text`, path: nodes.path })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), sql`${nodes.data}->>'sourceFileId' = ${fileId}`));

  const reaped = emptyDerivedCounts();
  let skipped = 0;
  const imageFolderPaths = new Set<string>();
  const wanted = options?.types ? new Set(options.types) : null;

  for (const row of rows) {
    if (wanted && !wanted.has(row.type)) continue;
    let ok: boolean;
    try {
      switch (row.type) {
        case 'file': {
          // No deleteDerived flag: depth one. Attachment and has_derived
          // refusals are skips, not failures — the audit keeps them visible.
          const res = await deleteFileById({ ownerId, fileId: row.id });
          ok = res.ok;
          if (ok && isPerDocumentExtractedImagesPath(row.path)) imageFolderPaths.add(row.path);
          break;
        }
        case 'table':
          ok = await deleteTable(ownerId, row.id);
          break;
        case 'page':
          ok = await deletePage(ownerId, row.id);
          break;
        case 'note':
          ok = await deleteNote(ownerId, row.id);
          break;
        default: {
          const deleted = await db
            .delete(nodes)
            .where(and(eq(nodes.id, row.id), eq(nodes.ownerId, ownerId)))
            .returning({ id: nodes.id });
          ok = deleted.length > 0;
        }
      }
    } catch {
      ok = false;
    }
    if (ok) {
      reaped[derivedBucketForType(row.type)] += 1;
      reaped.total += 1;
    } else {
      skipped += 1;
    }
  }

  // Fold up the per-document extracted-images folders the reap emptied.
  // deleteFolder refuses non-empty folders, so this is safe by construction;
  // a refusal (something else still lives there) is simply not an error.
  for (const path of imageFolderPaths) {
    try {
      const folder = await folderByPath({ ownerId, path });
      if (folder) await deleteFolder({ ownerId, folderId: folder.id });
    } catch {
      // Best-effort: a leftover empty folder is cosmetic, never data loss.
    }
  }

  return { reaped, skipped };
}

export type CascadeDeleteResult =
  | { ok: true; reaped: DerivedCounts; skipped: number }
  | {
      ok: false;
      reason: 'not_found' | 'attachment' | 'in_drawing';
      reaped: DerivedCounts;
      skipped: number;
      /** Populated on in_drawing so the caller can name the drawings. */
      drawings?: { id: string; title: string }[];
    };

/**
 * The confirmed-cascade orchestration used by every delete surface once the
 * user has said yes: reap the derived nodes first, then delete the source
 * file with `deleteDerived: true`. Reap-first ordering means a failure
 * anywhere leaves the source file present and the leftovers audit-visible.
 */
export async function deleteFileWithDerived(
  ownerId: string,
  fileId: string,
): Promise<CascadeDeleteResult> {
  // Checked BEFORE reaping. deleteFileById refuses a file a drawing still
  // uses, and the reap below is irreversible — running it first would destroy
  // the derived nodes and then decline to delete the file they came from.
  const inDrawings = await drawsReferencingFile(ownerId, fileId);
  if (inDrawings.length > 0) {
    return {
      ok: false,
      reason: 'in_drawing',
      drawings: inDrawings,
      reaped: emptyDerivedCounts(),
      skipped: 0,
    };
  }
  const { reaped, skipped } = await reapDerivedFromFile(ownerId, fileId);
  const res = await deleteFileById({ ownerId, fileId, deleteDerived: true });
  if (!res.ok) {
    // has_derived can't happen with the flag set; not_found / attachment can.
    const reason = res.reason === 'attachment' ? 'attachment' : 'not_found';
    return { ok: false, reason, reaped, skipped };
  }
  return { ok: true, reaped, skipped };
}
