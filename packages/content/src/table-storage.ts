import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, nodes, tables } from '@mantle/db';
import {
  ENGINE_VERSION,
  draftPathFor,
  readDocFile,
  resolveStoragePath,
  snapshotFile,
  type WorkbookStats,
} from '@mantle/tabledb';

import { ensureTableDoc, type TableDoc } from './table-model';

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

/**
 * Run `fn` while holding SELECT … FOR UPDATE on the table's registry row.
 * Serializes cross-process writers (UI autosave vs agent tool vs migration);
 * the lock releases when the transaction commits/rolls back.
 */
export async function withTableRegistryLock<T>(nodeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT node_id FROM tables WHERE node_id = ${nodeId} FOR UPDATE`);
    return fn(tx);
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
