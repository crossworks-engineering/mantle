import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, nodes, tables } from '@mantle/db';
import {
  ENGINE_VERSION,
  MATERIALIZE_MAX,
  describeWorkbook,
  draftPathFor,
  openTableFile,
  profileFile,
  profileToText,
  publishedPath,
  readDocClipped,
  readDocFile,
  relativeStoragePath,
  resolveStoragePath,
  snapshotFile,
  writeDocFile,
  type WorkbookStats,
  type WorkbookTabRef,
} from '@mantle/tabledb';

import { ensureTableDoc, type TableDoc } from './table-model';
import { tableToText } from './table-to-text';

/**
 * File-side plumbing for sqlite-native tables (Tables v2 P1) — the pieces
 * tables.ts composes:
 *
 *   - the REGISTRY LOCK SPINE (plan §3.3): every draft-create, draft write
 *     batch, commit, and (later) migration step takes a Postgres row lock on
 *     the `tables` registry row for the duration of the file operation. WAL
 *     covers intra-process concurrency; this lock is the cross-process writer
 *     coordinator — and it is what makes commit's atomic rename safe.
 *   - doc loading with draft-first semantics off the workbook files.
 *   - file cleanup that also sweeps the -wal/-shm sidecars.
 *
 * P1 tab naming: every workbook has the single engine-default tab; multi-tab
 * arrives with un-split imports (P3) on the same layout.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LockedRegistryRow = {
  shapeHash: string | null;
  storagePath: string | null;
  draftRev: number;
} | null;

/**
 * Run `fn` while holding SELECT … FOR UPDATE on the table's registry row.
 * Serializes cross-process writers (UI autosave vs agent tool vs migration);
 * the lock releases when the transaction commits/rolls back. The locked row's
 * coordination fields are passed to `fn` (null when the sidecar is missing) —
 * commit uses shapeHash to decide whether the LLM re-summarize is due.
 */
export async function withTableRegistryLock<T>(
  nodeId: string,
  fn: (tx: Tx, locked: LockedRegistryRow) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{ shape_hash: string | null; storage_path: string | null; draft_rev: number }>(
      sql`SELECT shape_hash, storage_path, draft_rev FROM tables WHERE node_id = ${nodeId} FOR UPDATE`,
    );
    const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
      shape_hash: string | null;
      storage_path: string | null;
      draft_rev: number;
    }[];
    const locked: LockedRegistryRow = rows[0]
      ? { shapeHash: rows[0].shape_hash, storagePath: rows[0].storage_path, draftRev: Number(rows[0].draft_rev) }
      : null;
    return fn(tx, locked);
  });
}

export type LoadedDocs = {
  data: TableDoc;
  draft: TableDoc | null;
  /** True row counts in the files (docs may be clipped windows). */
  totalRows: number;
  draftTotalRows: number | null;
  /** data/draft.rows were clipped at the materialize window — page the rest
   *  via the rows route / listRowsWindow. */
  docClipped: boolean;
};

/** Published + draft docs off the workbook file, CLIPPED at the materialize
 *  window (un-split imports can exceed it). Missing published file throws
 *  TableFileMissingError (never self-healed — durability gate 1); a missing
 *  draft file just means "no uncommitted edits". */
export function loadDocsFromFile(storagePath: string): LoadedDocs {
  const abs = resolveStoragePath(storagePath);
  const published = readDocClipped(abs, MATERIALIZE_MAX);
  const draftAbs = draftPathFor(abs);
  const draftClipped = existsSync(draftAbs) ? readDocClipped(draftAbs, MATERIALIZE_MAX) : null;
  return {
    data: ensureTableDoc(published.doc),
    draft: draftClipped ? ensureTableDoc(draftClipped.doc) : null,
    totalRows: published.total,
    draftTotalRows: draftClipped?.total ?? null,
    docClipped: published.clipped || (draftClipped?.clipped ?? false),
  };
}

/**
 * Ensure a draft workbook file exists (first edit copies published → draft,
 * plan §4) and return its absolute path. The copy is a plain file copy of the
 * checkpointed published file with FTS shadows STRIPPED — drafts never carry
 * shadows (column ops would fight the triggers; promote rebuilds them).
 * Caller holds the registry lock.
 */
export function ensureDraftFile(publishedAbs: string): string {
  const draftAbs = draftPathFor(publishedAbs);
  if (existsSync(draftAbs)) return draftAbs;
  // Checkpoint so the copy sees every committed page, then copy + strip.
  const pub = openTableFile(publishedAbs);
  try {
    pub.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    pub.close();
  }
  copyFileSync(publishedAbs, draftAbs);
  const draft = openTableFile(draftAbs);
  try {
    const tabs = draft.prepare(`SELECT physical_table FROM _tabs`).all();
    for (const t of tabs) {
      const pt = String(t.physical_table);
      draft.exec(`DROP TRIGGER IF EXISTS ${pt}_fts_ai`);
      draft.exec(`DROP TRIGGER IF EXISTS ${pt}_fts_ad`);
      draft.exec(`DROP TRIGGER IF EXISTS ${pt}_fts_au`);
      draft.exec(`DROP TABLE IF EXISTS ${pt}_fts`);
    }
    draft.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    draft.close();
  }
  return draftAbs;
}

type EnsureFileNode = { id: string; ownerId: string; title: string };
type EnsureLocked = { storagePath: string | null } | null;
type EnsureTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lazy migration (P4, plan §9): make a legacy JSONB table file-backed, under
 * the registry lock the caller already holds. Builds the published file from
 * `data`, migrates a pending `draftData` into `.draft.sqlite` IN THE SAME
 * STEP (stranding drafts was the data-loss hole), verifies row counts, and
 * updates the registry. No-op when already file-backed.
 */
export async function ensureFileBacked(
  tx: EnsureTx,
  node: EnsureFileNode,
  locked: EnsureLocked,
): Promise<{ storagePath: string; migrated: boolean }> {
  if (locked?.storagePath) return { storagePath: locked.storagePath, migrated: false };
  const [row] = await tx
    .select({ data: tables.data, draftData: tables.draftData })
    .from(tables)
    .where(eq(tables.nodeId, node.id))
    .limit(1);
  const doc = ensureTableDoc(row?.data ?? { columns: [], rows: [] });
  const publishedAbs = publishedPath(node.ownerId, node.id);
  const res = writeDocFile(publishedAbs, doc, { nodeId: node.id, ownerId: node.ownerId, fts: true });
  const back = readDocClipped(publishedAbs, 0);
  if (back.total !== doc.rows.length) {
    removeTableFile(publishedAbs);
    throw new Error(
      `table migration verify failed for ${node.id}: file has ${back.total} rows, JSONB has ${doc.rows.length} — kept on the JSONB path`,
    );
  }
  if (row?.draftData != null) {
    const draftDoc = ensureTableDoc(row.draftData);
    writeDocFile(draftPathFor(publishedAbs), draftDoc, { nodeId: node.id, ownerId: node.ownerId });
  }
  const storagePath = relativeStoragePath(node.ownerId, node.id);
  await tx
    .update(tables)
    .set({
      dataText: buildTableDataText(publishedAbs, doc, node.title),
      ...registryFileColumns(res, storagePath),
    })
    .where(eq(tables.nodeId, node.id));
  return { storagePath, migrated: true };
}

/** Absolute draft path for a registry storage_path. */
export function draftAbsFor(storagePath: string): string {
  return draftPathFor(resolveStoragePath(storagePath));
}

/** Remove a workbook file and its WAL/SHM sidecars (draft discard, table
 *  delete, failed-create cleanup). Best-effort by design. */
export function removeTableFile(abs: string): void {
  for (const f of [abs, `${abs}-wal`, `${abs}-shm`]) rmSync(f, { force: true });
}

/** The registry columns a successful file write updates, in drizzle `set`
 *  shape — one place so create/draft/commit can't drift apart. */
export function registryFileColumns(res: { sizeBytes: number; stats: WorkbookStats; shapeHash: string }, storagePath: string) {
  return {
    storagePath,
    sizeBytes: res.sizeBytes,
    stats: res.stats as unknown as Record<string, unknown>,
    shapeHash: res.shapeHash,
    engineVersion: ENGINE_VERSION,
  };
}

/** The SQL surface of an owned, file-backed table — what table_sql runs
 *  against and what table_get advertises. Null for legacy JSONB tables
 *  (any commit converts them). */
export async function tableSqlSurface(
  ownerId: string,
  nodeId: string,
): Promise<{ abs: string; tabs: WorkbookTabRef[] } | null> {
  const [row] = await db
    .select({ storagePath: tables.storagePath })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(and(eq(tables.nodeId, nodeId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row?.storagePath) return null;
  const abs = resolveStoragePath(row.storagePath);
  return { abs, tabs: describeWorkbook(abs) };
}

/** How many leading rows land in dataText — list-ILIKE routing for
 *  identifier-shaped strings ONLY (§12.1 amendment: rows never reach
 *  content_chunks or embeddings; deep row lookup is table_sql's job). */
export const DATA_TEXT_ROW_WINDOW = 200;

/**
 * dataText for a file-backed table (plan §6 L3, as amended): the L1 profile
 * text + the first 200 rows as markdown with an honest truncation note.
 * Serves the tables-list ILIKE and the extractor's LLM input; the profile
 * part is also what write_chunks re-derives per tab. Reads everything from
 * the file, so it works on the promote path where no doc is materialized.
 * The `doc` param is accepted for callers that have one (ignored — kept so
 * call sites read naturally) — the file is always the source of truth here.
 */
export function buildTableDataText(publishedAbs: string, _doc: TableDoc | null, title: string): string {
  const profiles = profileFile(publishedAbs);
  const head = profileToText(profiles, { title });
  const total = profiles.reduce((a, t) => a + t.rowCount, 0);
  const window = readDocClipped(publishedAbs, DATA_TEXT_ROW_WINDOW);
  const rowsMd = tableToText(ensureTableDoc(window.doc), { title });
  const note = window.clipped
    ? `\n\n(First ${DATA_TEXT_ROW_WINDOW} of ${total} rows shown — query the full data with table_sql.)`
    : '';
  return `${head}\n\n${rowsMd}${note}`;
}

/**
 * Background migration sweep (P4, plan §9): convert up to `batch` legacy
 * JSONB tables to file storage. Each conversion takes the registry lock —
 * the same one every draft/commit writer takes — so the sweep can never fork
 * against a concurrent edit. Returns how many converted (0 = all done).
 */
export async function sweepLegacyTables(batch = 5): Promise<number> {
  const legacy = await db
    .select({ id: nodes.id, ownerId: nodes.ownerId, title: nodes.title })
    .from(nodes)
    .innerJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.type, 'table'), sql`${tables.storagePath} IS NULL`))
    .limit(batch);
  let converted = 0;
  for (const n of legacy) {
    try {
      await withTableRegistryLock(n.id, async (tx, locked) => {
        if (!locked || locked.storagePath) return; // raced a lazy migration — fine
        await ensureFileBacked(tx, { id: n.id, ownerId: n.ownerId, title: n.title }, locked);
      });
      converted++;
    } catch (err) {
      // A failing table must not wedge the sweep — log and let the next tick
      // retry (the verify inside ensureFileBacked keeps it on the JSONB path).
      console.error(`[tables] migration sweep failed for ${n.id}:`, err instanceof Error ? err.message : err);
    }
  }
  if (converted > 0) console.log(`[tables] migration sweep converted ${converted} legacy table(s)`);
  return converted;
}

// ── Backup (durability gate 2) ───────────────────────────────────────────────

export type TableDbSnapshotReport = {
  snapshotted: { ownerId: string; nodeId: string; bytes: number; draft: boolean }[];
  /** Registry rows whose published file is absent — already-lost data, NOT
   *  snapshotted (and exactly what the sanity check screams about). */
  missing: { nodeId: string; storagePath: string }[];
  failed: { nodeId: string; error: string }[];
};

/**
 * Consistent-snapshot EVERY file-backed table into destDir via VACUUM INTO,
 * mirroring the live <owner>/<node>.sqlite layout so a restore drops straight
 * back into TABLE_DB_DIR. Drafts (uncommitted edits — the classic loss) are
 * snapshotted too when present. Same contract as snapshotAllAppDatabases:
 * report partial failures loudly, never let a missing file look backed up.
 */
export async function snapshotAllTableDatabases(destDir: string): Promise<TableDbSnapshotReport> {
  const rows = await db
    .select({ nodeId: tables.nodeId, ownerId: nodes.ownerId, storagePath: tables.storagePath })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(and(isNotNull(tables.storagePath)));

  const report: TableDbSnapshotReport = { snapshotted: [], missing: [], failed: [] };
  for (const r of rows) {
    const storagePath = r.storagePath!;
    let abs: string;
    try {
      abs = resolveStoragePath(storagePath);
    } catch (err) {
      report.failed.push({ nodeId: r.nodeId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!existsSync(abs)) {
      report.missing.push({ nodeId: r.nodeId, storagePath });
      continue;
    }
    for (const [file, draft] of [
      [abs, false],
      [draftPathFor(abs), true],
    ] as const) {
      if (draft && !existsSync(file)) continue;
      try {
        const dest = path.join(destDir, r.ownerId, path.basename(file));
        snapshotFile(file, dest);
        report.snapshotted.push({ ownerId: r.ownerId, nodeId: r.nodeId, bytes: statSync(dest).size, draft });
      } catch (err) {
        report.failed.push({ nodeId: r.nodeId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return report;
}
