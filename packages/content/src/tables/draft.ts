/**
 * Tables · grid mutation — ops, draft autosave, discard, and commit.
 *
 * This is the expensive half and the only one that indexes: an autosave
 * touches the DRAFT alone, so a long editing session produces one index per
 * commit rather than one per pause. Every path here serializes on the registry
 * row through the tables broker (table-broker.ts, A3b, plan 20.3: the new
 * workbook staged under a new revision name, then one short transaction
 * checks the row at the revision it was built from and points it there;
 * an op batch on an existing draft is the one in-place exception) and
 * refuses an app-bound table, so the export sync and a human editor cannot
 * interleave into a lost update.
 */
import { and, eq, sql } from 'drizzle-orm';
import { InputError } from '@mantle/std';
import {
  assertItemRight,
  db,
  nodes,
  tables,
  hasSummary,
  markContentChanged,
  oneRow,
  removeSqliteFile,
  StoreRefusedError,
} from '@mantle/db';
import { existsSync, statSync } from 'node:fs';
import {
  MATERIALIZE_MAX,
  TableTooLargeError,
  importMaxRows,
  fileStats,
  readDocClipped,
  resolveStoragePath,
  shapeHashOf,
  shapeHashOfFile,
  type TableOp,
} from '@mantle/tabledb';
import {
  coerceCell,
  ensureTableDoc,
  ensureWorkbookDoc,
  type TableDoc,
  type WorkbookDoc,
  type TableDetail,
} from '@mantle/content-core/table-model';
import {
  buildTableDataText,
  draftAbsOf,
  ensureFileBacked,
  registryFileColumns,
} from '../table-storage';
import {
  TableRevConflict,
  flipTable,
  opsInPlace,
  readTableRow,
  revisionBesideRow,
  stageDoc,
  stageDraftCopy,
  stageOps,
  stagePromote,
  stageThenFlipTable,
  type TableRow,
} from '../table-broker';
import { TAB_NAME, assertTableWritable, detailOf } from './shared';
import {
  pruneTableCommitSnapshots,
  recordCommitSnapshot,
  stageCommitSnapshot,
} from '../table-snapshots';
import type { AppHistoryActor } from '../apps';
import {
  effectiveTabCount,
  effectiveTabName,
  guardSingleTabWrite,
  isWorkbook,
  statsOrNull,
} from './workbook';

export type ApplyTableOpsResult =
  | { ok: true; draftRev: number; createdIds: (string | null)[] }
  | { ok: false; conflict: true; currentRev: number };

/** How many times a write without an etag builds again after another write
 *  moved the table between its read and its flip. */
const FLIP_TRIES = 3;

/** The JSONB draft mirror of a draft workbook (rollback safety): only while
 *  it fits the window AND stays single-tab (the mirror cannot represent
 *  tabs); otherwise null and the file is the sole draft carrier. */
function draftMirror(draftAbs: string): TableDoc | null {
  const clipped = readDocClipped(draftAbs, MATERIALIZE_MAX);
  const multiTab = fileStats(draftAbs).tabs.length > 1;
  return clipped.clipped || multiTab ? null : ensureTableDoc(clipped.doc);
}

/**
 * Apply an op batch to a table's DRAFT (P3): the whole batch lands atomically
 * on the draft workbook; `draft_rev` is the etag: a caller presenting a stale
 * `ifRev` gets a conflict (refetch, re-apply), never a silent interleave.
 * The store broker (A3b): a table with no draft yet gets one staged (a copy
 * of the published workbook, the batch applied to it), then flipped; an
 * existing draft takes the batch in place, in one short transaction whose
 * first statement is the check (the in-place exception, table-broker.ts).
 * A legacy JSONB table migrates to file storage first. Null when the table
 * doesn't exist or the caller does not read it.
 */
export async function applyTableOps(
  ownerId: string,
  id: string,
  ops: TableOp[],
  opts: { ifRev?: number } = {},
): Promise<ApplyTableOpsResult | null> {
  const [node] = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;
  await assertTableWritable(id);
  try {
    for (let attempt = 1; ; attempt++) {
      const row = await readTableRow(id);
      if (!row) return null;
      if (opts.ifRev !== undefined && row.draftRev !== opts.ifRev) {
        return { ok: false as const, conflict: true as const, currentRev: row.draftRev };
      }
      if (!row.storagePath) {
        // A legacy JSONB table: file-backed first (its own flip moves the
        // revision once: a caller with an etag sees one conflict).
        await ensureFileBacked({ id, ownerId, title: node.title });
        continue;
      }
      // A draft on disk takes the batch in place; a row naming a draft file
      // that is gone (A3b fix round 1, L1) gets a new draft below.
      const draftAbs = draftAbsOf(row.draftPath);
      if (draftAbs && existsSync(draftAbs)) {
        const done = await opsInPlace(id, opts.ifRev, async (tx, draftAbs, rev) => {
          const res = stageOps(draftAbs, ops, coerceCell);
          await tx
            .update(tables)
            .set({ draftData: draftMirror(draftAbs) })
            .where(eq(tables.nodeId, id));
          return { ok: true as const, draftRev: rev, createdIds: res.createdIds };
        });
        if (done !== 'no_draft') return done;
        if (attempt >= FLIP_TRIES) throw new TableRevConflict(row.draftRev);
        continue;
      }
      // The first edit: the draft is a copy of the published workbook, staged
      // with the batch applied, then flipped.
      const rel = revisionBesideRow(row, ownerId, id, true);
      const publishedAbs = resolveStoragePath(row.storagePath);
      try {
        return await stageThenFlipTable(
          () => {
            const abs = stageDraftCopy(publishedAbs, rel);
            try {
              const res = stageOps(abs, ops, coerceCell);
              return { files: [abs], res, mirror: draftMirror(abs) };
            } catch (err) {
              removeSqliteFile(abs);
              throw err;
            }
          },
          async (s) => {
            const { rev } = await flipTable(id, row.draftRev, {
              draftPath: rel,
              draftData: s.mirror,
              draftUpdatedAt: new Date(),
            });
            return { ok: true as const, draftRev: rev, createdIds: s.res.createdIds };
          },
        );
      } catch (err) {
        if (err instanceof TableRevConflict && opts.ifRev === undefined && attempt < FLIP_TRIES) {
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof TableRevConflict) {
      return { ok: false as const, conflict: true as const, currentRev: err.currentRev };
    }
    if (err instanceof StoreRefusedError) return null;
    throw err;
  }
}

export type SaveTableDraftResult =
  { ok: true; draftRev: number } | { ok: false; conflict: true; currentRev: number };

/** Autosave the working grid to the DRAFT only: published `data`,
 *  `data_text`, summary, embedding, and the extractor are all untouched. Cheap
 *  and frequent. Returns null if the table doesn't exist. Accepts a bare doc
 *  (single-tab tables) or a full WorkbookDoc (tab-aware callers / import).
 *  `ifRev` is the same etag the op route uses: a stale value conflicts
 *  instead of clobbering newer edits. `replace` marks a deliberate
 *  whole-workbook replacement (import): the payload is a complete new table
 *  parsed from a file, so the clipped-grid truncation guard doesn't apply and
 *  the payload cap is the import ceiling, not the grid window.
 *  The store broker (A3b): the new draft is staged under a new revision name,
 *  then one short transaction checks the row at the revision the guards read
 *  and points the draft at it. */
export async function saveTableDraft(
  ownerId: string,
  id: string,
  data: TableDoc | WorkbookDoc,
  opts: { ifRev?: number; replace?: boolean; appSync?: boolean } = {},
): Promise<SaveTableDraftResult | null> {
  const [node] = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;
  await assertTableWritable(id, opts.appSync);
  const workbook = isWorkbook(data) ? ensureWorkbookDoc(data) : null;
  const doc = workbook ? null : ensureTableDoc(data as TableDoc);
  const totalRows = workbook
    ? workbook.tabs.reduce((a, t) => a + t.rows.length, 0)
    : doc!.rows.length;
  const payloadCap = opts.replace ? importMaxRows() : MATERIALIZE_MAX;
  if (totalRows > payloadCap) throw new TableTooLargeError(totalRows, payloadCap);
  try {
    for (let attempt = 1; ; attempt++) {
      const row = await readTableRow(id);
      // No row (gone, frozen in a personal space, or not the caller's to
      // read): null and nothing written.
      if (!row) return null;
      if (opts.ifRev !== undefined && row.draftRev !== opts.ifRev) {
        return { ok: false as const, conflict: true as const, currentRev: row.draftRev };
      }
      if (!row.storagePath && workbook) {
        // A workbook draft has no JSONB mirror: the file is its ONLY carrier,
        // so a legacy table converts to file-backed before the draft lands.
        await ensureFileBacked({ id, ownerId, title: node.title });
        continue;
      }
      try {
        const { rev } = row.storagePath
          ? await saveDraftFile(row, ownerId, id, workbook, doc, opts.replace === true)
          : await flipTable(id, row.draftRev, { draftData: doc, draftUpdatedAt: new Date() });
        return { ok: true as const, draftRev: rev };
      } catch (err) {
        if (err instanceof TableRevConflict && opts.ifRev === undefined && attempt < FLIP_TRIES) {
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof TableRevConflict) {
      return { ok: false as const, conflict: true as const, currentRev: err.currentRev };
    }
    if (err instanceof StoreRefusedError) return null;
    throw err;
  }
}

/** A file-backed table's whole-doc draft: guarded, staged, flipped. */
async function saveDraftFile(
  row: TableRow,
  ownerId: string,
  id: string,
  workbook: WorkbookDoc | null,
  doc: TableDoc | null,
  replace: boolean,
): Promise<{ rev: number }> {
  if (!replace) {
    // Whole-doc writes are only legal while the table itself fits the window:
    // a windowed doc saved whole would truncate the table (audit finding 5:
    // an exactly-10k clipped doc slipped the row-count guard). Guard against
    // the LARGEST doc this write would clobber: the draft can have grown past
    // the published stats via op batches.
    const effRows = Math.max(
      row.totalRows ?? 0,
      statsOrNull(draftAbsOf(row.draftPath))?.totalRows ?? 0,
    );
    if (effRows > MATERIALIZE_MAX) throw new TableTooLargeError(effRows, MATERIALIZE_MAX);
  }
  if (!workbook) guardSingleTabWrite(effectiveTabCount(row));
  const rel = revisionBesideRow(row, ownerId, id, true);
  return stageThenFlipTable(
    () => ({
      files: [
        stageDoc(rel, workbook ?? doc!, {
          nodeId: id,
          ownerId,
          tabName: workbook ? TAB_NAME : effectiveTabName(row),
        }).abs,
      ],
    }),
    () =>
      flipTable(id, row.draftRev, {
        draftPath: rel,
        // JSONB draft mirror carries single-tab docs only (the legacy
        // rollback lever can't represent tabs: v2.1 plan decision 2).
        draftData: workbook ? null : doc,
        draftUpdatedAt: new Date(),
      }),
  );
}

/** Throw away the working draft. Published grid + index untouched. The store
 *  broker (A3b): the row no longer points at a draft (the check, as the
 *  caller); the draft file is then the sweep's. */
export async function discardTableDraft(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return false;
  await assertTableWritable(id);
  try {
    await flipTable(id, undefined, { draftPath: null, draftData: null, draftUpdatedAt: null });
    return true;
  } catch (err) {
    if (err instanceof StoreRefusedError) return false;
    throw err;
  }
}

/** What a commit flips to, staged before its transaction. */
type StagedCommit = {
  files: string[];
  rel: string;
  abs: string;
  sizeBytes: number;
  stats: ReturnType<typeof fileStats>;
  shapeHash: string;
  history: ReturnType<typeof stageCommitSnapshot>;
  clipped: ReturnType<typeof readDocClipped>;
  mirror: TableDoc | Record<string, never>;
  dataText: string;
};

/** What a commit changed, for its re-index: the shape-hash gate (plan
 *  section 6). Cell-only edits on a table that has a summary are `cells`
 *  (the vector again, the summary and entities kept: the extractor reuses
 *  the summary and skips its model pass); a schema change, a first commit,
 *  or a table with no summary is `schema` (the whole pass), as main did. An
 *  empty summary is no summary (hasSummary, the extractor's own test): on
 *  main its commit ran the model too, and as `cells` it left the table
 *  with no vector (A10 #7 fix round 2, M3). */
export function committedChange(
  oldShapeHash: string | null,
  newShapeHash: string,
  nodeData: unknown,
): 'cells' | 'schema' {
  return oldShapeHash != null && oldShapeHash === newShapeHash && hasSummary(nodeData)
    ? 'cells'
    : 'schema';
}

/**
 * Commit: publish `data` (or, with none, the server draft) as canonical,
 * recompute `data_text`, clear the draft, bump the version, and fire the
 * extractor. The ONLY path that indexes a table's cells: autosaves never do, so a
 * long editing session produces exactly one re-index per commit (cost-safe,
 * matching Pages). Returns the published detail, or null if the table
 * doesn't exist. The store broker (A3b): the new published workbook (and the
 * history copy of the one it replaces) is staged, then one short transaction
 * checks the row at the revision it was built from, points it at the new
 * workbook, drops the draft pointer, and writes the node and history rows.
 */
export async function commitTable(
  ownerId: string,
  id: string,
  data?: TableDoc | WorkbookDoc,
  opts: { appSync?: boolean; actor?: AppHistoryActor; note?: string | null } = {},
): Promise<TableDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;
  // Edit first (the cheap rights read first, pre-check removal fix round
  // A): before the staging, and the same refusal whether a draft is there
  // or not. An app's sync is the brain's own (the app's data door asked).
  if (!opts.appSync) await assertItemRight(id, 'edit');
  await assertTableWritable(id, opts.appSync);

  const workbook = data && isWorkbook(data) ? ensureWorkbookDoc(data) : null;
  const doc = data === undefined || workbook ? null : ensureTableDoc(data as TableDoc);
  const commitDoc: TableDoc | WorkbookDoc | null = data === undefined ? null : (workbook ?? doc!);
  const commitTotalRows = workbook
    ? workbook.tabs.reduce((a, t) => a + t.rows.length, 0)
    : (doc?.rows.length ?? 0);
  if (commitDoc && commitTotalRows > MATERIALIZE_MAX) {
    throw new TableTooLargeError(commitTotalRows, MATERIALIZE_MAX);
  }

  let flipped: { out: typeof node; staged: StagedCommit; draft: boolean } | undefined;
  try {
    for (let attempt = 1; ; attempt++) {
      const row = await readTableRow(id);
      if (!row) return null; // gone, frozen in a personal space, or unreadable
      let draftAbs: string | null = null;
      if (!commitDoc) {
        // ── Promote path (P3): no doc posted: publish the SERVER draft. ──
        if (!row.storagePath) {
          // Legacy JSONB table: its draft (if any) lives in draftData: the
          // doc path's semantics via the mirror.
          const [p] = await db
            .select({ draft: tables.draftData })
            .from(tables)
            .where(eq(tables.nodeId, id))
            .limit(1);
          if (p?.draft == null) throw new NoDraftError();
          return commitTable(ownerId, id, ensureTableDoc(p.draft), opts);
        }
        draftAbs = draftAbsOf(row.draftPath);
        if (!draftAbs || !existsSync(draftAbs)) throw new NoDraftError();
      } else if (!workbook) {
        // A bare single-tab doc must not clobber a multi-tab workbook (the
        // whole-grid UI path pre-P5); workbook payloads replace everything
        // by design (import).
        guardSingleTabWrite(effectiveTabCount(row));
      }
      const tabName = workbook ? TAB_NAME : effectiveTabName(row);
      const rel = revisionBesideRow(row, ownerId, id, false);
      const oldPublishedAbs = row.storagePath ? resolveStoragePath(row.storagePath) : null;
      const fromDraft = draftAbs;
      try {
        // Everything is read from the staged files before the flip; nothing
        // runs inside the flip but its transaction, and nothing after its
        // commit but this function's own reads (A3b fix round 1, H2).
        const staged = await stageThenFlipTable(
          (): StagedCommit => {
            const files: string[] = [];
            try {
              let abs: string;
              let shapeHash: string;
              let stats: ReturnType<typeof fileStats>;
              if (fromDraft) {
                // Promote via VACUUM INTO, not a bare rename (audit findings
                // 1+2): the copy reads THROUGH the draft's WAL, so frames a
                // concurrent reader kept un-checkpointed are captured.
                abs = stagePromote(fromDraft, rel);
                files.push(abs);
                shapeHash = shapeHashOfFile(abs);
                stats = fileStats(abs);
              } else {
                const st = stageDoc(rel, commitDoc!, {
                  nodeId: id,
                  ownerId,
                  tabName,
                  fts: true,
                });
                abs = st.abs;
                files.push(abs);
                shapeHash = shapeHashOf(commitDoc!, tabName);
                stats = st.res.stats;
              }
              // The published workbook this commit replaces is kept on the
              // table's history (apps plan Phase 4), except for an app-bound
              // table's sync (the app is the master).
              const history =
                !opts.appSync && oldPublishedAbs
                  ? stageCommitSnapshot({ ownerId, tableId: id, publishedAbs: oldPublishedAbs })
                  : null;
              if (history) files.push(history.abs);
              const clipped = readDocClipped(abs, MATERIALIZE_MAX);
              // JSONB mirror: single-tab, in-window docs only (the rollback
              // lever can't represent tabs: v2.1 plan decision 2).
              const mirror = fromDraft
                ? clipped.clipped || stats.tabs.length > 1
                  ? {}
                  : ensureTableDoc(clipped.doc)
                : workbook
                  ? {}
                  : doc!;
              return {
                files,
                rel,
                abs,
                sizeBytes: statSync(abs).size,
                stats,
                shapeHash,
                history,
                clipped,
                mirror,
                dataText: buildTableDataText(abs, fromDraft ? null : doc, node.title),
              };
            } catch (err) {
              files.forEach(removeSqliteFile);
              throw err;
            }
          },
          async (s) => {
            const { out } = await flipTable(
              id,
              row.draftRev,
              {
                data: s.mirror,
                dataText: s.dataText,
                draftPath: null,
                draftData: null,
                draftUpdatedAt: null,
                version: sql`${tables.version} + 1`,
                updatedAt: new Date(),
                ...registryFileColumns(
                  { sizeBytes: s.sizeBytes, stats: s.stats, shapeHash: s.shapeHash },
                  s.rel,
                ),
              },
              async (tx) => {
                const [updated] = await tx
                  .update(nodes)
                  .set({ updatedAt: new Date() })
                  .where(eq(nodes.id, id))
                  .returning();
                const committed = oneRow('tables', updated ? [updated] : [], 'table');
                // Announced when this transaction commits (the kind
                // registry's `indexed`).
                const nodeRow =
                  (await markContentChanged(tx, { id, type: 'table' }, [
                    committedChange(row.shapeHash, s.shapeHash, committed.data),
                  ])) ?? committed;
                if (s.history) {
                  const [v] = await tx
                    .select({ version: tables.version })
                    .from(tables)
                    .where(eq(tables.nodeId, id))
                    .limit(1);
                  await recordCommitSnapshot(tx, s.history, {
                    ownerId,
                    tableId: id,
                    // The copy holds the version before this commit.
                    version: v ? Number(v.version) - 1 : null,
                    ...(opts.actor ? { actor: opts.actor } : {}),
                    ...(opts.note ? { note: opts.note } : {}),
                  });
                }
                return nodeRow;
              },
            );
            return { out, staged: s, draft: fromDraft !== null };
          },
        );
        flipped = staged;
        break;
      } catch (err) {
        if (err instanceof TableRevConflict && attempt < FLIP_TRIES) continue;
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof NoDraftError) {
      return Promise.reject(new InputError('no draft to commit: the table is already published'));
    }
    if (err instanceof StoreRefusedError) return null;
    throw err;
  }
  // After the commit: the detail from what was staged, the history prune,
  // the extractor.
  if (!flipped) return null;
  const { out, staged: s, draft } = flipped;
  const result = draft
    ? detailOf(out, ensureTableDoc(s.clipped.doc), null, {
        totalRows: s.clipped.total,
        docClipped: s.clipped.clipped,
      })
    : detailOf(out, workbook ? ensureTableDoc(workbook.tabs[0]) : doc!, null, {
        totalRows: commitTotalRows,
      });
  if (s.history !== null) await pruneTableCommitSnapshots(id);
  return result;
}

class NoDraftError extends Error {}
