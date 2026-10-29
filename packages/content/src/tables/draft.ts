/**
 * Tables · grid mutation — ops, draft autosave, discard, and commit.
 *
 * This is the expensive half and the only one that indexes: an autosave
 * touches the DRAFT alone, so a long editing session produces one index per
 * commit rather than one per pause. Every path here serializes on the registry
 * row through the tables broker (table-broker.ts: the new
 * workbook staged under a new revision name, then one short transaction
 * checks the row at the revision it was built from and points it there;
 * an op batch on an existing draft is the one in-place exception) and
 * refuses an app-bound table, so the export sync and a human editor cannot
 * interleave into a lost update.
 */
import { and, eq, sql } from 'drizzle-orm';
import { errorMessage, InputError } from '@mantle/std';
import {
  assertAppRunWriteHome,
  assertItemRight,
  db,
  EXTRACT_SKIPPED_KEY,
  nodes,
  tables,
  hasSummary,
  inAppRunWrite,
  markContentChanged,
  oneRow,
  readIndexWork,
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
  historyKept,
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

/** A team app's write: the most rows
 *  its Table's draft may hold after the batch. The box's table ceiling
 *  (TABLE_IMPORT_MAX_ROWS) when lower: an app loop at 60 calls a minute
 *  never grows a draft past what a person would load. */
export const APP_DRAFT_MAX_ROWS = 50_000;

/** A team app's write: the largest Table file (its draft, else the
 *  published workbook) it still writes to, bytes. */
export const APP_DRAFT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Why a team app's batch may not land, or null: the draft would pass
 * `maxRows` rows (`rows` there now, `adding` more), or its file is already
 * past APP_DRAFT_MAX_BYTES. Pure (the numbers in); applyTableOps asks it
 * for an app's write (inAppRunWrite) before anything is staged.
 */
export function appDraftCeilingRefusal(
  rows: number,
  adding: number,
  bytes: number,
  maxRows = Math.min(APP_DRAFT_MAX_ROWS, importMaxRows()),
): string | null {
  if (rows + adding > maxRows) {
    return `This Table would hold ${(rows + adding).toLocaleString('en-US')} rows, past the ${maxRows.toLocaleString('en-US')}-row ceiling of a team app's writes. Nothing was written: commit or trim the Table first, or have an admin load the rows.`;
  }
  if (bytes > APP_DRAFT_MAX_BYTES) {
    return `This Table's file is past the ${APP_DRAFT_MAX_BYTES / (1024 * 1024)} MB ceiling of a team app's writes. Nothing was written: commit or trim the Table first, or have an admin load the rows.`;
  }
  return null;
}

/** applyTableOps' ceiling for a team app's write: the rows and bytes of the
 *  file the batch lands on (the draft, else the published workbook it is
 *  copied from). Throws the refusal; nothing else is checked here. */
function assertAppDraftCeiling(file: string, ops: readonly TableOp[]): void {
  // No file (gone under a race): the store refuses the write itself.
  if (!existsSync(file)) return;
  const adding = ops.filter((o) => o.op === 'row_add').length;
  const refused = appDraftCeilingRefusal(fileStats(file).totalRows, adding, statSync(file).size);
  if (refused) throw new InputError(refused);
}

/**
 * Apply an op batch to a table's DRAFT: the whole batch lands atomically
 * on the draft workbook; `draft_rev` is the etag: a caller presenting a stale
 * `ifRev` gets a conflict (refetch, re-apply), never a silent interleave.
 * The store broker: a table with no draft yet gets one staged (a copy
 * of the published workbook, the batch applied to it), then flipped; an
 * existing draft takes the batch in place, in one short transaction whose
 * first statement is the check (the in-place exception, table-broker.ts).
 * A legacy JSONB table migrates to file storage first. Null when the table
 * doesn't exist or the caller does not read it.
 */
/**
 * Whether the caller may write the grid of table `id` now, asked exactly as
 * applyTableOps asks before it writes (the scoped read, the edit right, a
 * writable table: not app-bound, not a snapshot copy; a team app's home):
 * null when it may, else the refusal in words. For a caller that must know
 * BEFORE it spends on a write that follows (circuit_verify asks it before
 * any vision call). Refuses nothing itself; the write still asks.
 */
export async function tableWriteRefusal(ownerId: string, id: string): Promise<string | null> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return 'the table is not one the caller reads';
  try {
    await assertItemRight(id, 'edit');
    await assertTableWritable(id);
    if (inAppRunWrite()) await assertAppRunWriteHome(id);
  } catch (err) {
    return errorMessage(err);
  }
  return null;
}

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
  // Edit first (pre-check removal part 2), after the scoped read above (a
  // table the scope does not read is the null of none): before a draft is
  // staged on disk, and the same refusal whether a draft is there or not.
  await assertItemRight(id, 'edit');
  await assertTableWritable(id);
  // A team app's write (inAppRunWrite): only on a Table homed in the app's
  // scope, asked again here where the write runs (a move since the verdict
  // takes none), and within the app's ceilings below.
  const appWrite = inAppRunWrite();
  if (appWrite) await assertAppRunWriteHome(id);
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
      // that is gone gets a new draft below.
      const draftAbs = draftAbsOf(row.draftPath);
      if (appWrite) {
        const onDisk = draftAbs && existsSync(draftAbs);
        assertAppDraftCeiling(onDisk ? draftAbs : resolveStoragePath(row.storagePath), ops);
      }
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
 *  The store broker: the new draft is staged under a new revision name,
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
  // Edit first, as applyTableOps asks it: before the draft is staged. An
  // app's sync is the brain's own (the app's data door asked).
  if (!opts.appSync) await assertItemRight(id, 'edit');
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
    // a windowed doc saved whole would truncate the table (an exactly-10k
    // clipped doc must not slip the row-count guard). Guard against
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
        // rollback lever can't represent tabs).
        draftData: workbook ? null : doc,
        draftUpdatedAt: new Date(),
      }),
  );
}

/** Throw away the working draft. Published grid + index untouched. The store
 *  broker: the row no longer points at a draft (the check, as the
 *  caller); the draft file is then the sweep's. */
export async function discardTableDraft(
  ownerId: string,
  id: string,
  opts: { ifRev?: number } = {},
): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return false;
  // Edit first, as applyTableOps asks it.
  await assertItemRight(id, 'edit');
  await assertTableWritable(id);
  try {
    // With `ifRev`: only the draft at that revision (the caller's own,
    // untouched since); one someone else wrote to is kept.
    await flipTable(id, opts.ifRev, { draftPath: null, draftData: null, draftUpdatedAt: null });
    return true;
  } catch (err) {
    if (err instanceof StoreRefusedError) return false;
    if (opts.ifRev !== undefined && err instanceof TableRevConflict) return false;
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

/** What a commit changed, for its re-index: the shape-hash gate. Cell-only
 *  edits on a table that has a summary are `cells` (the vector again, the
 *  summary and entities kept: the extractor reuses the summary and skips
 *  its model pass); a schema change, a first commit, or a table with no
 *  summary is `schema` (the whole pass). An empty summary is no summary
 *  (hasSummary, the extractor's own test): as `cells` it would leave the
 *  table with no vector. */
export function committedChange(
  oldShapeHash: string | null,
  newShapeHash: string,
  nodeData: unknown,
): 'cells' | 'schema' {
  return oldShapeHash != null && oldShapeHash === newShapeHash && hasSummary(nodeData)
    ? 'cells'
    : 'schema';
}

/** A team app's commit (inAppRunWrite) waits this long after the
 *  Table's last model pass before it may start another: at most one
 *  app-started pass per Table per window. */
export const APP_COMMIT_PASS_GAP_MS = 10 * 60 * 1000;

/** What a team app's refused commit is told. */
export const APP_COMMIT_WAIT_MESSAGE =
  'This table is still being indexed; try the commit again in a few minutes.';

/** When the Table's last model pass ended, ms, or null: the latest of the
 *  extractor's completion marker, its summary write and a terminal skip. */
function lastPassAt(data: unknown): number | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const skipped = d[EXTRACT_SKIPPED_KEY] as { at?: unknown } | null | undefined;
  let last: number | null = null;
  for (const v of [d.extract_completed_at, d.summary_at, skipped?.at]) {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return last;
}

/**
 * Whether a team app's commit must wait, and why: a
 * commit that runs the whole pass (`schema`) aborts a pass in flight (the
 * extractor's index write is guarded on the row's xmin) and starts another,
 * so an app committing on each submit could keep a model busy without end.
 * Refused while a pass is pending or running (an 'extract' stamp), and a
 * `schema` commit within APP_COMMIT_PASS_GAP_MS of the last pass. A
 * cell-only commit on a summarised Table (a re-embed, no model call) is
 * never held. `change` null: only the pending check. Admin and UI commits
 * never ask.
 */
export function appCommitWait(
  nodeData: unknown,
  change: 'cells' | 'schema' | null,
  now: number = Date.now(),
): string | null {
  if (readIndexWork(nodeData) === 'extract') return APP_COMMIT_WAIT_MESSAGE;
  if (change !== 'schema') return null;
  const last = lastPassAt(nodeData);
  return last !== null && now - last < APP_COMMIT_PASS_GAP_MS ? APP_COMMIT_WAIT_MESSAGE : null;
}

/**
 * Commit: publish `data` (or, with none, the server draft) as canonical,
 * recompute `data_text`, clear the draft, bump the version, and fire the
 * extractor. The ONLY path that indexes a table's cells: autosaves never do, so a
 * long editing session produces exactly one re-index per commit (cost-safe,
 * matching Pages). Returns the published detail, or null if the table
 * doesn't exist. The store broker: the new published workbook (and the
 * history copy of the one it replaces) is staged, then one short transaction
 * checks the row at the revision it was built from, points it at the new
 * workbook, drops the draft pointer, and writes the node and history rows.
 */
export async function commitTable(
  ownerId: string,
  id: string,
  data?: TableDoc | WorkbookDoc,
  opts: {
    appSync?: boolean;
    actor?: AppHistoryActor;
    note?: string | null;
    /** Keep the committed summary and entities even though the shape
     *  changed: the re-index is `cells` (the vector and the profile again,
     *  no model pass) when the table has a summary. For a rebuild whose
     *  meaning is unchanged (the dwg-reindex task adding tabs to the same
     *  drawing), never for a user's edit. */
    keepSummary?: boolean;
    /** Never start a model pass: with a summary the re-index is `cells`
     *  (as keepSummary), without one no index work is asked at all (the
     *  table keeps its index as it was; `cells` there would leave it with
     *  no vector, `schema` would call the model). For an append of
     *  evidence rows that must never spend (the image check's Checks tab,
     *  circuit_verify), never for a user's edit. */
    noModelPass?: boolean;
    /** Publish the server draft only at this draft revision (the one the
     *  caller's own write left): a draft someone else added to since is
     *  refused (TableRevConflict), never published with it. */
    ifRev?: number;
  } = {},
): Promise<TableDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;
  // Edit first (the cheap rights read first): before the staging, and the
  // same refusal whether a draft is there or not. An app's sync is the brain's own (the app's data door asked).
  if (!opts.appSync) await assertItemRight(id, 'edit');
  await assertTableWritable(id, opts.appSync);
  // A team app's commit (inAppRunWrite): only a Table homed in the app's
  // scope, asked again where the write runs (applyTableOps' rule).
  const appWrite = inAppRunWrite();
  if (appWrite) {
    await assertAppRunWriteHome(id);
    // Asked early on what is known before the staging (a pass pending, or
    // no summary: the commit is `schema`), and again in the flip on the
    // locked row with the change the commit makes.
    const wait = appCommitWait(node.data, hasSummary(node.data) ? null : 'schema');
    if (wait) throw new InputError(wait);
  }

  const workbook = data && isWorkbook(data) ? ensureWorkbookDoc(data) : null;
  const doc = data === undefined || workbook ? null : ensureTableDoc(data as TableDoc);
  const commitDoc: TableDoc | WorkbookDoc | null = data === undefined ? null : (workbook ?? doc!);
  const commitTotalRows = workbook
    ? workbook.tabs.reduce((a, t) => a + t.rows.length, 0)
    : (doc?.rows.length ?? 0);
  if (commitDoc && commitTotalRows > MATERIALIZE_MAX) {
    throw new TableTooLargeError(commitTotalRows, MATERIALIZE_MAX);
  }

  // Whether this commit keeps the version it replaces (asked once, before
  // the staging, which runs synchronously).
  const kept = !opts.appSync && (await historyKept());
  let flipped: { out: typeof node; staged: StagedCommit; draft: boolean } | undefined;
  try {
    for (let attempt = 1; ; attempt++) {
      const row = await readTableRow(id);
      if (!row) return null; // gone, frozen in a personal space, or unreadable
      if (opts.ifRev !== undefined && row.draftRev !== opts.ifRev) {
        throw new TableRevConflict(row.draftRev);
      }
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
        // commit but this function's own reads.
        const staged = await stageThenFlipTable(
          (): StagedCommit => {
            const files: string[] = [];
            try {
              let abs: string;
              let shapeHash: string;
              let stats: ReturnType<typeof fileStats>;
              if (fromDraft) {
                // Promote via VACUUM INTO, not a bare rename: the copy reads
                // THROUGH the draft's WAL, so frames a
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
              // table's history, except for an app-bound
              // table's sync (the app is the master).
              const history =
                !opts.appSync && oldPublishedAbs
                  ? stageCommitSnapshot({
                      ownerId,
                      tableId: id,
                      publishedAbs: oldPublishedAbs,
                      kept,
                    })
                  : null;
              if (history) files.push(history.abs);
              const clipped = readDocClipped(abs, MATERIALIZE_MAX);
              // JSONB mirror: single-tab, in-window docs only (the rollback
              // lever can't represent tabs).
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
                const change =
                  (opts.keepSummary || opts.noModelPass) && hasSummary(committed.data)
                    ? ('cells' as const)
                    : opts.noModelPass
                      ? null
                      : committedChange(row.shapeHash, s.shapeHash, committed.data);
                // A team app's commit waits out a pass (MED-1): thrown here,
                // the flip rolls back and its stage is removed.
                const wait = appWrite ? appCommitWait(committed.data, change) : null;
                if (wait) throw new InputError(wait);
                // Announced when this transaction commits (the kind
                // registry's `indexed`).
                const nodeRow =
                  (change ? await markContentChanged(tx, { id, type: 'table' }, [change]) : null) ??
                  committed;
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
