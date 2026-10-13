/**
 * The tables store's broker (workspaces arch A3b, plan section 6;
 * docs/store-brokers.md): the ONLY writer of the workbook files under
 * TABLE_DB_DIR, and the only importer of their write API
 * (@mantle/tabledb/write; the store-brokers lint pins it). Readers keep
 * @mantle/tabledb.
 *
 * Every write of a table's files is one `withTableWrite`: the registry row
 * is locked AND checked by one statement, the draft_rev bump, run as the
 * caller (on the write role for a login's write: the row rules and the edit
 * check see it), which must match exactly one row; only then the disk,
 * through the store broker helper (@mantle/db store-broker.ts), which keeps
 * the revision in a journal beside the published workbook until the commit.
 * A write the database refuses changes nothing on disk. A commit that fails
 * after the disk write is repaired on the next access (`repairTable`):
 * the database's draft_rev decides.
 *
 * Server-only (node:fs, node:sqlite).
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import {
  brokerTransaction,
  db,
  repairStore,
  runReadPathWrite,
  StoreRefusedError,
  tables,
  type StoreJournal,
  type StoreWrite,
} from '@mantle/db';
import {
  applyOpsToFile,
  finalizePublishedFile,
  openTableFile,
  writeDocFile,
} from '@mantle/tabledb/write';
import {
  draftPathFor,
  publishedPath,
  resolveStoragePath,
  snapshotFile,
  type ApplyResult,
  type CoerceFn,
  type TableOp,
  type WorkbookDocLike,
  type TableDocLike,
} from '@mantle/tabledb';
import { ensureTableDoc } from '@mantle/content-core/table-model';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DocArg = Parameters<typeof writeDocFile>[1];
type MetaArg = Parameters<typeof writeDocFile>[2];
type WriteRes = ReturnType<typeof writeDocFile>;

/** The registry row a table write holds: the coordination fields, with
 *  `draftRev` the revision BEFORE this write (the etag a caller compares). */
export type LockedTable = {
  shapeHash: string | null;
  storagePath: string | null;
  draftRev: number;
  totalRows: number | null;
  tabCount: number | null;
};

/** A caller's `ifRev` is not the table's revision: nothing was written. */
export class TableRevConflict extends Error {
  constructor(readonly currentRev: number) {
    super(`table revision conflict (now ${currentRev})`);
    this.name = 'TableRevConflict';
  }
}

/** Thrown inside a table write to end it with `value` and nothing kept:
 *  the bump rolls back with everything else (a commit that finds no draft
 *  changes no revision, as before A3b). */
export class TableWriteAbort<V> extends Error {
  constructor(readonly value: V) {
    super('table write ended with nothing written');
    this.name = 'TableWriteAbort';
  }
}

/** The journal of a table's files, beside its published workbook. */
export function tableJournalPath(publishedAbs: string): string {
  return `${publishedAbs}.broker`;
}

/** The published workbook of a registry row (its storage path, or the
 *  layout's path before the first file). */
function publishedAbsOf(ownerId: string, nodeId: string, storagePath: string | null): string {
  return storagePath ? resolveStoragePath(storagePath) : publishedPath(ownerId, nodeId);
}

/** Fold a workbook's WAL into it, so a copy of the main file is whole. */
function checkpoint(abs: string): void {
  if (!existsSync(abs)) return;
  const f = openTableFile(abs);
  try {
    f.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    f.close();
  }
}

type Row = {
  shape_hash: string | null;
  storage_path: string | null;
  draft_rev: number;
  total_rows: string | null;
  tab_count: number | null;
};

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** The table's file operations inside one write (after its check). */
export class TableWrite {
  constructor(
    readonly tx: Tx,
    readonly w: StoreWrite,
    readonly nodeId: string,
    readonly ownerId: string,
  ) {}

  /** Write a whole workbook (a new file renamed over the old one). */
  writeDoc(abs: string, doc: DocArg, meta: MetaArg): Promise<WriteRes> {
    return this.w.replace(abs, () => writeDocFile(abs, doc, meta), {
      sqlite: true,
      checkpoint: () => checkpoint(abs),
    });
  }

  /** An op batch on the draft, where it lies. */
  applyOps(draftAbs: string, ops: TableOp[], coerce: CoerceFn): Promise<ApplyResult> {
    return this.w.inPlace(draftAbs, () => applyOpsToFile(draftAbs, ops, coerce));
  }

  /** Remove a workbook and its sidecars (kept aside until the commit). */
  remove(abs: string): void {
    this.w.remove(abs, { sqlite: true });
  }

  /**
   * The draft workbook, made on the first edit from the published one (plan
   * section 4): a checkpointed copy with the FTS shadows STRIPPED (drafts
   * never carry them; the promote rebuilds them). Returns its path.
   */
  async ensureDraft(publishedAbs: string): Promise<string> {
    const draftAbs = draftPathFor(publishedAbs);
    if (existsSync(draftAbs)) return draftAbs;
    await this.w.create(
      draftAbs,
      () => {
        checkpoint(publishedAbs);
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
      },
      { sqlite: true },
    );
    return draftAbs;
  }

  /**
   * Publish the draft: a VACUUM INTO copy that reads through the draft's
   * WAL, renamed over the published file (never deleted first), the draft
   * removed, the FTS shadows rebuilt. The old published file is the undo.
   */
  async promote(draftAbs: string, publishedAbs: string): Promise<void> {
    await this.w.replace(
      publishedAbs,
      () => {
        const promoteTmp = `${publishedAbs}.promote-${randomUUID().slice(0, 8)}`;
        try {
          snapshotFile(draftAbs, promoteTmp);
          // The OLD published file's sidecars go BEFORE the swap: SQLite
          // does not match a WAL to its file, so a leftover -wal would be
          // replayed into the new one.
          rmSync(`${publishedAbs}-wal`, { force: true });
          rmSync(`${publishedAbs}-shm`, { force: true });
          renameSync(promoteTmp, publishedAbs);
        } finally {
          for (const f of [promoteTmp, `${promoteTmp}-wal`, `${promoteTmp}-shm`]) {
            rmSync(f, { force: true });
          }
        }
      },
      { sqlite: true, checkpoint: () => checkpoint(publishedAbs) },
    );
    this.remove(draftAbs);
    // Covered by the replace above: its undo brings the old file back.
    await this.w.inPlace(publishedAbs, () => finalizePublishedFile(publishedAbs));
  }

  /** Copy `source` (a history file) over the draft. */
  async restoreDraft(source: string, draftAbs: string): Promise<void> {
    await this.w.replace(
      draftAbs,
      () => {
        const tmp = `${draftAbs}.restore-${randomUUID().slice(0, 8)}`;
        try {
          copyFileSync(source, tmp);
          for (const f of [`${draftAbs}-wal`, `${draftAbs}-shm`]) rmSync(f, { force: true });
          renameSync(tmp, draftAbs);
        } finally {
          rmSync(tmp, { force: true });
        }
      },
      { sqlite: true, checkpoint: () => checkpoint(draftAbs) },
    );
  }

  /** Keep a copy of `src` at `dest` (a history file): a hard link, else a
   *  copy; removed again if the write does not commit. */
  async keepCopy(src: string, dest: string): Promise<void> {
    mkdirSync(path.dirname(dest), { recursive: true });
    await this.w.create(dest, () => {
      try {
        // A hard link costs nothing: the published file is replaced by a
        // rename, never changed in place, so the link keeps this version.
        rmSync(dest, { force: true });
        copyLink(src, dest);
      } catch (err) {
        rmSync(dest, { force: true });
        throw err;
      }
    });
  }
}

function copyLink(src: string, dest: string): void {
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

/**
 * One write of a table's files. The lock and the check are ONE statement:
 * the draft_rev bump, as the caller, exactly one row. No row (the table is
 * gone, or the caller does not read it): null, the callers' not-found
 * answer, and nothing on disk. A stale `ifRev`: TableRevConflict, nothing
 * written. `fn` runs after the check with the row as it was.
 */
export async function withTableWrite<T>(
  ownerId: string,
  nodeId: string,
  fn: (tx: Tx, locked: LockedTable, t: TableWrite) => Promise<T>,
  opts: { ifRev?: number } = {},
): Promise<T | null> {
  try {
    return await brokerTransaction<Tx, T>(
      'tables',
      (run) => db.transaction(run),
      async (tx, w) => {
        const row = w.one(
          rowsOf<Row>(
            await tx.execute(sql`
              UPDATE tables SET draft_rev = draft_rev + 1 WHERE node_id = ${nodeId}
              RETURNING shape_hash, storage_path, draft_rev,
                        stats->>'totalRows' AS total_rows,
                        jsonb_array_length(stats->'tabs') AS tab_count`),
          ),
          'table',
        );
        const rev = Number(row.draft_rev);
        const locked: LockedTable = {
          shapeHash: row.shape_hash,
          storagePath: row.storage_path,
          draftRev: rev - 1,
          totalRows: row.total_rows == null ? null : Number(row.total_rows),
          tabCount: row.tab_count == null ? null : Number(row.tab_count),
        };
        if (opts.ifRev !== undefined && locked.draftRev !== opts.ifRev) {
          throw new TableRevConflict(locked.draftRev);
        }
        const publishedAbs = publishedAbsOf(ownerId, nodeId, row.storage_path);
        const journal = tableJournalPath(publishedAbs);
        const draftAbs = draftPathFor(publishedAbs);
        // A journal an earlier write left: repaired first (journalAt), with
        // the draft's JSONB mirror at hand (read only then).
        if (existsSync(journal)) {
          const [m] = rowsOf<{ draft_data: unknown }>(
            await tx.execute(sql`SELECT draft_data FROM tables WHERE node_id = ${nodeId}`),
          );
          mirrors.set(draftAbs, m?.draft_data ?? null);
        }
        try {
          w.journalAt(journal, rev, rev - 1);
        } finally {
          mirrors.delete(draftAbs);
        }
        return fn(tx, locked, new TableWrite(tx, w, nodeId, ownerId));
      },
      { inPlace: draftFromMirror },
    );
  } catch (err) {
    if (err instanceof StoreRefusedError) return null;
    if (err instanceof TableWriteAbort) return err.value as T;
    throw err;
  }
}

/**
 * A write that makes a table's files with its row, inside the caller's
 * transaction `open` (the heads of the create): `fn` gets the StoreWrite
 * once the caller's own INSERT of the node is checked (`checkInsert`).
 */
export async function withTableCreate<T, X>(
  ownerId: string,
  nodeId: string,
  open: (run: (tx: X) => Promise<T>) => Promise<T>,
  fn: (tx: X, t: TableWrite, checkInsert: <R>(row: R | undefined) => R) => Promise<T>,
): Promise<T> {
  return brokerTransaction<X, T>('tables', open, async (tx, w) => {
    // The heads' transaction: the same drizzle surface as a db.transaction.
    const t = new TableWrite(tx as unknown as Tx, w, nodeId, ownerId);
    return fn(tx, t, (row) => {
      const r = w.inserted(row, 'table');
      // The registry row is made in this transaction at revision 0.
      w.journalAt(tableJournalPath(publishedPath(ownerId, nodeId)), 0, null);
      return r;
    });
  });
}

/**
 * A table's delete: `open` is the delete's transaction, `del` deletes the
 * node (the registry row cascades) and returns the deleted rows, exactly
 * one; then the files are moved aside, dropped on the commit, put back on a
 * rollback.
 */
export async function withTableDelete<X>(
  ownerId: string,
  nodeId: string,
  storagePath: string | null,
  extra: readonly string[],
  open: (run: (tx: X) => Promise<void>) => Promise<void>,
  del: (tx: X) => Promise<readonly unknown[]>,
): Promise<void> {
  await brokerTransaction<X, void>('tables', open, async (x, w) => {
    const tx = x as unknown as Tx;
    const [reg] = await tx
      .select({ draftRev: tables.draftRev })
      .from(tables)
      .where(eq(tables.nodeId, nodeId))
      .limit(1);
    w.one(await del(x), 'table');
    if (!storagePath) return;
    const publishedAbs = resolveStoragePath(storagePath);
    // Committed means the row is gone (null).
    w.journalAt(tableJournalPath(publishedAbs), null, reg?.draftRev ?? null);
    for (const abs of [publishedAbs, draftPathFor(publishedAbs), ...extra]) {
      w.remove(abs, { sqlite: true });
    }
  });
}

/** In-place repair of a table's draft: rebuilt from the JSONB mirror the
 *  database holds for it (single-tab, in-window drafts), else kept. */
const mirrors = new Map<string, unknown>();
function draftFromMirror(_j: StoreJournal, target: string): boolean {
  if (!target.endsWith('.draft.sqlite') || !mirrors.has(target)) return false;
  const mirror = mirrors.get(target);
  if (mirror == null) return false;
  writeDocFile(target, ensureTableDoc(mirror) as unknown as TableDocLike, {
    nodeId: path.basename(target, '.draft.sqlite'),
    ownerId: path.basename(path.dirname(target)),
  });
  return true;
}

/**
 * Repair on read (A3b): a journal beside the table's published workbook
 * means a write's commit was never seen. Under the registry lock (as
 * system(repair:store-broker): a reader may hold no write right), the
 * database's draft_rev decides: the write committed (tidy), or it did not
 * (the disk goes back). Costs one existsSync when there is nothing to do.
 */
export async function repairTable(nodeId: string, storagePath: string | null): Promise<void> {
  if (!storagePath) return;
  const publishedAbs = resolveStoragePath(storagePath);
  const journal = tableJournalPath(publishedAbs);
  if (!existsSync(journal)) return;
  await runReadPathWrite('repair:store-broker', () =>
    db.transaction(async (tx) => {
      const [reg] = rowsOf<{ draft_rev: number; draft_data: unknown }>(
        await tx.execute(
          sql`SELECT draft_rev, draft_data FROM tables WHERE node_id = ${nodeId} FOR UPDATE`,
        ),
      );
      const draftAbs = draftPathFor(publishedAbs);
      mirrors.set(draftAbs, reg?.draft_data ?? null);
      try {
        repairStore(journal, reg ? Number(reg.draft_rev) : null, { inPlace: draftFromMirror });
      } finally {
        mirrors.delete(draftAbs);
      }
    }),
  );
}

/** The workbook document types a write takes (re-exported for callers). */
export type { WorkbookDocLike, TableDocLike };
