/**
 * Tables · grid mutation — ops, draft autosave, discard, and commit.
 *
 * This is the expensive half and the only one that indexes: an autosave
 * touches the DRAFT alone, so a long editing session produces one index per
 * commit rather than one per pause. Every path here serializes on the registry
 * row through `withTableRegistryLock` and refuses an app-bound table, so the
 * export sync and a human editor cannot interleave into a lost update.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, tables, notifyNodeIngested } from '@mantle/db';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import {
  MATERIALIZE_MAX,
  TableTooLargeError,
  importMaxRows,
  applyOpsToFile,
  draftPathFor,
  fileStats,
  finalizePublishedFile,
  publishedPath,
  readDocClipped,
  relativeStoragePath,
  resolveStoragePath,
  shapeHashOf,
  shapeHashOfFile,
  snapshotFile,
  writeDocFile,
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
  draftAbsFor,
  ensureDraftFile,
  ensureFileBacked,
  registryFileColumns,
  removeTableFile,
  withTableRegistryLock,
} from '../table-storage';
import { TAB_NAME, assertTableWritable, detailOf } from './shared';
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

/**
 * Apply an op batch to a table's DRAFT (P3): the whole batch lands atomically
 * on the draft workbook file under the registry lock; `draft_rev` is the etag
 * — a caller presenting a stale `ifRev` gets a conflict (refetch, re-apply),
 * never a silent interleave. A legacy JSONB table lazily migrates to file
 * storage on its first op (same lock, so migration and ops can't fork).
 * Returns null when the table doesn't exist.
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
  return withTableRegistryLock(id, async (tx, locked) => {
    if (!locked) return null;
    if (opts.ifRev !== undefined && locked.draftRev !== opts.ifRev) {
      return { ok: false as const, conflict: true as const, currentRev: locked.draftRev };
    }
    const { storagePath } = await ensureFileBacked(tx, { id, ownerId, title: node.title }, locked);
    const publishedAbs = resolveStoragePath(storagePath);
    const draftAbs = ensureDraftFile(publishedAbs);
    const res = applyOpsToFile(draftAbs, ops, coerceCell);
    // JSONB draft mirror (rollback safety) — only while it fits the window
    // AND stays single-tab (the mirror can't represent tabs); otherwise null
    // and the file is the sole draft carrier.
    const clipped = readDocClipped(draftAbs, MATERIALIZE_MAX);
    const multiTab = fileStats(draftAbs).tabs.length > 1;
    await tx
      .update(tables)
      .set({
        draftData: clipped.clipped || multiTab ? null : ensureTableDoc(clipped.doc),
        draftUpdatedAt: new Date(),
        draftRev: sql`${tables.draftRev} + 1`,
      })
      .where(eq(tables.nodeId, id));
    return { ok: true as const, draftRev: locked.draftRev + 1, createdIds: res.createdIds };
  });
}

export type SaveTableDraftResult =
  { ok: true; draftRev: number } | { ok: false; conflict: true; currentRev: number };

/** Autosave the working grid to the DRAFT only — published `data`,
 *  `data_text`, summary, embedding, and the extractor are all untouched. Cheap
 *  and frequent. Returns null if the table doesn't exist. Accepts a bare doc
 *  (single-tab tables) or a full WorkbookDoc (tab-aware callers / import).
 *  `ifRev` is the same etag the op route uses — a stale value conflicts
 *  instead of clobbering newer edits. `replace` marks a deliberate
 *  whole-workbook replacement (import): the payload is a complete new table
 *  parsed from a file, so the clipped-grid truncation guard doesn't apply and
 *  the payload cap is the import ceiling, not the grid window. */
export async function saveTableDraft(
  ownerId: string,
  id: string,
  data: TableDoc | WorkbookDoc,
  opts: { ifRev?: number; replace?: boolean; appSync?: boolean } = {},
): Promise<SaveTableDraftResult | null> {
  const [row] = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return null;
  await assertTableWritable(id, opts.appSync);
  const workbook = isWorkbook(data) ? ensureWorkbookDoc(data) : null;
  const doc = workbook ? null : ensureTableDoc(data as TableDoc);
  const totalRows = workbook
    ? workbook.tabs.reduce((a, t) => a + t.rows.length, 0)
    : doc!.rows.length;
  const payloadCap = opts.replace ? importMaxRows() : MATERIALIZE_MAX;
  if (totalRows > payloadCap) throw new TableTooLargeError(totalRows, payloadCap);
  // Registry lock spine: the draft-file rebuild and the registry update are
  // one locked step, so a concurrent agent op / second process can't
  // interleave mid-write. Storage is decided from the LOCKED row, not a
  // pre-lock read — racing the migration sweep with a stale null path wrote
  // the draft to JSONB only, invisible to every file-backed read surface
  // (audit finding 4). draft_rev bumps on every batch (the op route's etag).
  return await withTableRegistryLock(id, async (tx, locked) => {
    const currentRev = locked?.draftRev ?? 0;
    if (opts.ifRev !== undefined && currentRev !== opts.ifRev) {
      return { ok: false as const, conflict: true as const, currentRev };
    }
    let storagePath = locked?.storagePath ?? null;
    if (!storagePath && workbook) {
      // A workbook draft has no JSONB mirror — the file is its ONLY carrier,
      // so a legacy table converts to file-backed before the draft lands.
      storagePath = (await ensureFileBacked(tx, { id, ownerId, title: row.title }, locked))
        .storagePath;
    }
    if (storagePath) {
      if (!opts.replace) {
        // Whole-doc writes are only legal while the table itself fits the
        // window — a windowed doc saved whole would truncate the table (audit
        // finding 5: an exactly-10k clipped doc slipped the row-count guard).
        // Guard against the LARGEST doc this write would clobber: the draft
        // can have grown past the published stats via op batches.
        const effRows = Math.max(
          locked?.totalRows ?? 0,
          statsOrNull(draftAbsFor(storagePath))?.totalRows ?? 0,
        );
        if (effRows > MATERIALIZE_MAX) throw new TableTooLargeError(effRows, MATERIALIZE_MAX);
      }
      if (!workbook) guardSingleTabWrite(effectiveTabCount(locked, storagePath));
      writeDocFile(draftAbsFor(storagePath), workbook ?? doc!, {
        nodeId: id,
        ownerId,
        tabName: workbook ? TAB_NAME : effectiveTabName(storagePath),
      });
    }
    await tx
      .update(tables)
      .set({
        // JSONB draft mirror carries single-tab docs only (the legacy
        // rollback lever can't represent tabs — v2.1 plan decision 2).
        draftData: workbook ? null : doc,
        draftUpdatedAt: new Date(),
        draftRev: sql`${tables.draftRev} + 1`,
      })
      .where(eq(tables.nodeId, id));
    return { ok: true as const, draftRev: currentRev + 1 };
  });
}

/** Throw away the working draft. Published grid + index untouched. */
export async function discardTableDraft(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return false;
  await assertTableWritable(id);
  await withTableRegistryLock(id, async (tx, locked) => {
    if (locked?.storagePath) removeTableFile(draftAbsFor(locked.storagePath));
    await tx
      .update(tables)
      .set({ draftData: null, draftUpdatedAt: null, draftRev: sql`${tables.draftRev} + 1` })
      .where(eq(tables.nodeId, id));
  });
  return true;
}

/**
 * Commit: publish `data` as canonical, recompute `data_text`, clear the draft,
 * bump the version, and fire the extractor. The ONLY path that indexes a table —
 * autosaves never do, so a long editing session produces exactly one re-index
 * per commit (cost-safe, matching Pages). Returns the published detail, or null
 * if the table doesn't exist.
 */
export async function commitTable(
  ownerId: string,
  id: string,
  data?: TableDoc | WorkbookDoc,
  opts: { appSync?: boolean } = {},
): Promise<TableDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;
  await assertTableWritable(id, opts.appSync);

  // ── Promote path (P3): no doc posted — publish the SERVER draft file. ──
  // The op route is the writer; commit is: lock → checkpoint → atomic rename
  // draft→published → rebuild FTS → re-derive stats/shape/dataText from the
  // file. This is the only commit shape that works past the materialize
  // window (there is no whole doc to post).
  if (data === undefined) {
    const result = await withTableRegistryLock(id, async (tx, locked) => {
      if (!locked?.storagePath) {
        // Legacy JSONB table: its draft (if any) lives in draftData — fall
        // through to the doc path semantics via the mirror.
        const [p] = await tx
          .select({ draft: tables.draftData })
          .from(tables)
          .where(eq(tables.nodeId, id))
          .limit(1);
        if (p?.draft == null) return 'no_draft' as const;
        return { legacyDraft: ensureTableDoc(p.draft) };
      }
      const publishedAbs = resolveStoragePath(locked.storagePath);
      const draftAbs = draftPathFor(publishedAbs);
      if (!existsSync(draftAbs)) return 'no_draft' as const;

      // Promote via VACUUM INTO, not a bare rename (audit findings 1+2):
      // the snapshot reads THROUGH the draft's WAL, so frames a concurrent
      // reader kept un-checkpointed are captured (a checkpoint's status is
      // advisory and a rename moves only the main file — the old path could
      // silently drop the newest ops). And the published file is REPLACED
      // atomically, never deleted first — a crash at any step leaves either
      // the old published file or the new one, both complete.
      const promoteTmp = `${publishedAbs}.promote-${randomUUID().slice(0, 8)}`;
      try {
        snapshotFile(draftAbs, promoteTmp);
        // Sweep the OLD published file's sidecars BEFORE the swap: SQLite
        // does NOT salt-match a WAL to its database file, so a leftover -wal
        // (checkpoint blocked by a concurrent reader) would be recovered
        // into the NEW file on the next write open — silent corruption of
        // committed data. We hold the registry lock; no writer races this.
        rmSync(`${publishedAbs}-wal`, { force: true });
        rmSync(`${publishedAbs}-shm`, { force: true });
        renameSync(promoteTmp, publishedAbs);
      } finally {
        removeTableFile(promoteTmp);
      }
      removeTableFile(draftAbs);
      finalizePublishedFile(publishedAbs);

      const newShapeHash = shapeHashOfFile(publishedAbs);
      const newData = { ...((node.data ?? {}) as Record<string, unknown>) };
      const shapeUnchanged =
        locked.shapeHash != null &&
        locked.shapeHash === newShapeHash &&
        typeof newData.summary === 'string';
      if (!shapeUnchanged) {
        delete newData.summary;
        delete newData.summary_model;
        delete newData.summary_at;
        delete newData.entities;
      }
      delete newData.extract_completed_at;

      const [row] = await tx
        .update(nodes)
        .set({ data: newData, embedding: null, updatedAt: new Date() })
        .where(eq(nodes.id, id))
        .returning();
      if (!row) throw new Error('commitTable: update returned no row');

      const clipped = readDocClipped(publishedAbs, MATERIALIZE_MAX);
      const stats = fileStats(publishedAbs);
      // JSONB mirror: single-tab, in-window docs only (the rollback lever
      // can't represent tabs — v2.1 plan decision 2).
      const mirror = clipped.clipped || stats.tabs.length > 1 ? {} : ensureTableDoc(clipped.doc);
      await tx
        .update(tables)
        .set({
          data: mirror,
          dataText: buildTableDataText(publishedAbs, null, node.title),
          draftData: null,
          draftUpdatedAt: null,
          draftRev: sql`${tables.draftRev} + 1`,
          version: sql`${tables.version} + 1`,
          updatedAt: new Date(),
          ...registryFileColumns(
            { sizeBytes: statSync(publishedAbs).size, stats, shapeHash: newShapeHash },
            locked.storagePath,
          ),
        })
        .where(eq(tables.nodeId, id));
      return detailOf(row, ensureTableDoc(clipped.doc), null, {
        totalRows: clipped.total,
        docClipped: clipped.clipped,
      });
    });
    if (result === 'no_draft') {
      return Promise.reject(new Error('no draft to commit — the table is already published'));
    }
    if (result && typeof result === 'object' && 'legacyDraft' in result) {
      return commitTable(ownerId, id, result.legacyDraft);
    }
    if (result) await notifyNodeIngested(id);
    return result ?? null;
  }

  const workbook = isWorkbook(data) ? ensureWorkbookDoc(data) : null;
  const doc = workbook ? null : ensureTableDoc(data as TableDoc);
  const commitDoc: TableDoc | WorkbookDoc = workbook ?? doc!;
  const commitTotalRows = workbook
    ? workbook.tabs.reduce((a, t) => a + t.rows.length, 0)
    : doc!.rows.length;
  if (commitTotalRows > MATERIALIZE_MAX)
    throw new TableTooLargeError(commitTotalRows, MATERIALIZE_MAX);

  // Commit under the registry lock (plan §3.3): write the new published file
  // (build + FTS shadows + checkpoint + atomic rename inside writeDocFile),
  // drop the draft file, then bump version/stats — one serialized step. A
  // legacy JSONB table converts to file-backed here (commit has the full doc
  // in hand, and the lock is the same one migration takes, so the two can
  // never fork).
  const publishedAbs = publishedPath(ownerId, id);
  const result = await withTableRegistryLock(id, async (tx, locked) => {
    // Shape-hash gate (plan §6): cell-only edits keep the existing summary/
    // entities — the extractor sees them and skips its LLM pass, refreshing
    // only the cheap deterministic layers (profile chunks, embedding).
    // Schema changes (or a first commit) clear them → full re-summarize.
    // extract_completed_at is always cleared: SOME re-index always runs.
    // Bare docs keep the file's existing tab name (a whole-doc commit is not
    // a rename — 'Sheet1' here flipped the shape hash and re-summarized).
    const tabName = workbook ? TAB_NAME : effectiveTabName(locked?.storagePath ?? null);
    const newShapeHash = shapeHashOf(commitDoc, tabName);
    const newData = { ...((node.data ?? {}) as Record<string, unknown>) };
    const shapeUnchanged =
      locked?.shapeHash != null &&
      locked.shapeHash === newShapeHash &&
      typeof newData.summary === 'string';
    if (!shapeUnchanged) {
      delete newData.summary;
      delete newData.summary_model;
      delete newData.summary_at;
      delete newData.entities;
    }
    delete newData.extract_completed_at;

    // A bare single-tab doc must not clobber a multi-tab workbook (the
    // whole-grid UI path pre-P5); workbook payloads replace everything by
    // design (import).
    if (!workbook) guardSingleTabWrite(effectiveTabCount(locked, locked?.storagePath ?? null));
    const [row] = await tx
      .update(nodes)
      .set({ data: newData, embedding: null, updatedAt: new Date() })
      .where(eq(nodes.id, id))
      .returning();
    if (!row) throw new Error('commitTable: update returned no row');
    const res = writeDocFile(publishedAbs, commitDoc, { nodeId: id, ownerId, tabName, fts: true });
    removeTableFile(draftAbsFor(relativeStoragePath(ownerId, id)));
    await tx
      .update(tables)
      .set({
        // JSONB mirror: single-tab docs only (v2.1 plan decision 2).
        data: workbook ? {} : doc!,
        dataText: buildTableDataText(publishedAbs, doc, node.title),
        draftData: null,
        draftUpdatedAt: null,
        draftRev: sql`${tables.draftRev} + 1`,
        version: sql`${tables.version} + 1`,
        updatedAt: new Date(),
        ...registryFileColumns(res, relativeStoragePath(ownerId, id)),
      })
      .where(eq(tables.nodeId, id));
    return detailOf(row, workbook ? ensureTableDoc(workbook.tabs[0]) : doc!, null, {
      totalRows: commitTotalRows,
    });
  });

  await notifyNodeIngested(id);
  return result;
}
