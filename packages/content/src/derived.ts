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
import {
  db,
  itemWriteVerdicts,
  nodes,
  systemStep,
  withDeadlockRetry,
  withNodeDeleteHeads,
} from '@mantle/db';
import {
  dashToLtree,
  deleteFileById,
  deleteFolder,
  derivedBucketForType,
  emptyDerivedCounts,
  fileDeleteBlock,
  EXTRACTED_IMAGES_SLUG,
  autoFiledSourcePath,
  FILES_ROOT_LABEL,
  folderByPath,
  type DerivedCounts,
} from '@mantle/files';

import { deleteNote } from './notes';
import { deletePage } from './pages';
import { deleteTable } from './tables';

export { describeDerivedCounts, type DerivedCounts } from '@mantle/files';

/**
 * Is this ltree path a per-document extracted-images folder (a strict child
 * of `files.auto_filed.extracted_images`)? The reap may deleteFolder ONLY such a child,
 * never the shared extracted-images root — and deleteFolder itself still
 * refuses non-empty folders, so a folder holding anything the reap didn't
 * remove survives by construction.
 */
export function isPerDocumentExtractedImagesPath(path: string): boolean {
  // Auto-filed's folder, and the top-level one older brains had until the
  // file watcher moved it in (reconcileAutoFiled).
  const roots = [
    autoFiledSourcePath('extracted-images'),
    `${FILES_ROOT_LABEL}.${dashToLtree(EXTRACTED_IMAGES_SLUG)}`,
  ];
  return roots.some((root) => path.startsWith(`${root}.`) && path.length > root.length + 1);
}

export type ReapResult = {
  /** Nodes actually deleted, bucketed the same way as the count preview. */
  reaped: DerivedCounts;
  /** Nodes left in place — email-attachment refusals, a (never yet observed)
   *  grandchild-bearing image, or a per-node error. Skips stay visible in the
   *  dangling_source_file audit check rather than failing the whole reap. */
  skipped: number;
  /** Derived items the caller may not delete (F4 fix round 3, H1): ones its
   *  scope does not read, or reads but does not manage. Kept, never reaped,
   *  and only counted (no name, no id): they stay where they are, their
   *  source gone (the dangling_source_file audit lists them). */
  kept: number;
};

/**
 * Delete every node whose `data.sourceFileId` points at this file, one level
 * deep, best-effort per node, of the ones the caller may delete. Extractor
 * code guarantees derived nodes never spawn grandchildren (an extracted
 * image is never re-opened for images), but the depth-one guard holds
 * regardless: a derived file node that somehow HAS its own derived nodes
 * refuses deletion and counts as a skip.
 *
 * The caller's check, in two named steps (F4 fix round 3, H1): the derived
 * ids are found brain-wide after the file's manage check, then each one is
 * asked of the caller's scope (manage, as its own delete asks it) and only
 * the ones that pass are reaped; the rest are kept and counted. A member's
 * or an Admin user's cascade never deletes an item in a workspace it does
 * not manage. System work (the dangling-derived script) reaps them all.
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
  // Found brain-wide (a derived item the caller does not read is one all
  // the same), after the source file's manage check: ids and kinds only,
  // never handed back to the caller.
  const rows = await systemStep('derived-items', { items: [fileId], need: 'manage' }, () =>
    derivedOf(ownerId, fileId),
  );
  const wanted = options?.types ? new Set(options.types) : null;
  const chosen = rows.filter((r) => !wanted || wanted.has(r.type));
  // Each one asked of the caller's scope (the step's own check): reaped
  // only where the caller may delete it.
  return systemStep(
    'derived-items',
    { items: chosen.map((r) => r.id), need: 'manage', only: 'allowed' },
    async (allowed) => {
      const ok = new Set(allowed);
      const res = await reapDerived(
        ownerId,
        chosen.filter((r) => ok.has(r.id)),
      );
      return { ...res, kept: chosen.length - ok.size };
    },
  );
}

type DerivedRow = { id: string; type: string; path: string };

/** The nodes derived from file `fileId`, on the system pool. */
async function derivedOf(ownerId: string, fileId: string): Promise<DerivedRow[]> {
  return db
    .select({ id: nodes.id, type: sql<string>`${nodes.type}::text`, path: nodes.path })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), sql`${nodes.data}->>'sourceFileId' = ${fileId}`));
}

/** reapDerivedFromFile's reap of `rows`, on the system pool. */
async function reapDerived(
  ownerId: string,
  rows: readonly DerivedRow[],
): Promise<{ reaped: DerivedCounts; skipped: number }> {
  const reaped = emptyDerivedCounts();
  let skipped = 0;
  const imageFolderPaths = new Set<string>();

  for (const row of rows) {
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
          const deleted = await withDeadlockRetry(() =>
            withNodeDeleteHeads([row.id], (tx) =>
              tx
                .delete(nodes)
                .where(and(eq(nodes.id, row.id), eq(nodes.ownerId, ownerId)))
                .returning({ id: nodes.id }),
            ),
          );
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
      // Its own system folder (Auto-filed / Extracted images / <document>).
      if (folder) await deleteFolder({ ownerId, folderId: folder.id, allowSystem: true });
    } catch {
      // Best-effort: a leftover empty folder is cosmetic, never data loss.
    }
  }

  return { reaped, skipped };
}

export type CascadeDeleteResult =
  | { ok: true; reaped: DerivedCounts; skipped: number; kept: number }
  | {
      ok: false;
      reason: 'not_found' | 'attachment' | 'in_drawing';
      reaped: DerivedCounts;
      skipped: number;
      /** Derived items the caller may not delete, kept (a count only; F4 fix
       *  round 3, H1). */
      kept: number;
      /** Populated on in_drawing so the caller can name the drawings (the
       *  ones it reads). */
      drawings?: { id: string; title: string }[];
      /** On in_drawing: how many more place it that the caller does not
       *  read, when any (F4 fix round 2). */
      hiddenDrawings?: number;
    };

/**
 * The confirmed-cascade orchestration used by every delete surface once the
 * user has said yes: reap the derived nodes first, then delete the source
 * file with `deleteDerived: true`. Reap-first ordering means a failure
 * anywhere leaves the source file present and the leftovers audit-visible.
 * Derived items the caller may not delete are kept (`kept`, a count): the
 * file still goes, as the caller confirmed, and they keep their content
 * with a source that is gone.
 */
export async function deleteFileWithDerived(
  ownerId: string,
  fileId: string,
): Promise<CascadeDeleteResult> {
  const none = { reaped: emptyDerivedCounts(), skipped: 0, kept: 0 };
  // The item check first (F4 fix round 2): the reap below is the brain's
  // and irreversible, so it runs only for a caller that may delete the file
  // (its manage, in the caller's scope; system work is not checked).
  // Refused as the delete itself refuses it: not found.
  if ((await itemWriteVerdicts([fileId], 'manage')).get(fileId) !== 'ok') {
    return { ok: false, reason: 'not_found', ...none };
  }
  // Every refusal no confirm resolves, BEFORE reaping (F4 fix round 3, L1:
  // the attachment's too, which deleteFileById only met after the reap).
  // deleteFileById refuses them, and the reap below is irreversible —
  // running it first would destroy the derived nodes and then decline to
  // delete the file they came from. Every drawing, brain-wide: one the
  // caller does not read breaks too.
  const blocked = await fileDeleteBlock(ownerId, fileId);
  if (blocked) return { ok: false, ...blocked, ...none };
  const { reaped, skipped, kept } = await reapDerivedFromFile(ownerId, fileId);
  const res = await deleteFileById({ ownerId, fileId, deleteDerived: true });
  if (!res.ok) {
    // has_derived can't happen with the flag set; not_found / attachment can.
    const reason = res.reason === 'attachment' ? 'attachment' : 'not_found';
    return { ok: false, reason, reaped, skipped, kept };
  }
  return { ok: true, reaped, skipped, kept };
}
