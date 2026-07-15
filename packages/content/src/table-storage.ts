import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, nodes, tables } from '@mantle/db';
import {
  ENGINE_VERSION,
  describeWorkbook,
  draftPathFor,
  profileFile,
  profileToText,
  readDocFile,
  resolveStoragePath,
  snapshotFile,
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

/** Published + draft docs off the workbook file. Missing published file
 *  throws TableFileMissingError (never self-healed — durability gate 1);
 *  a missing draft file just means "no uncommitted edits". */
export function loadDocsFromFile(storagePath: string): { data: TableDoc; draft: TableDoc | null } {
  const abs = resolveStoragePath(storagePath);
  const data = ensureTableDoc(readDocFile(abs));
  const draftAbs = draftPathFor(abs);
  const draft = existsSync(draftAbs) ? ensureTableDoc(readDocFile(draftAbs)) : null;
  return { data, draft };
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
 * part is also what write_chunks re-derives per tab.
 */
export function buildTableDataText(publishedAbs: string, doc: TableDoc, title: string): string {
  const profiles = profileFile(publishedAbs);
  const head = profileToText(profiles, { title });
  const windowed = doc.rows.length > DATA_TEXT_ROW_WINDOW;
  const slice = windowed ? { ...doc, rows: doc.rows.slice(0, DATA_TEXT_ROW_WINDOW) } : doc;
  const rowsMd = tableToText(slice, { title });
  const note = windowed
    ? `\n\n(First ${DATA_TEXT_ROW_WINDOW} of ${doc.rows.length} rows shown — query the full data with table_sql.)`
    : '';
  return `${head}\n\n${rowsMd}${note}`;
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
