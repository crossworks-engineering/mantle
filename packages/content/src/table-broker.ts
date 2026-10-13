/**
 * The tables store's broker (workspaces arch A3b, plan sections 6 and 20.3;
 * docs/store-brokers.md): the ONLY writer of the workbook files under
 * TABLE_DB_DIR, and the only importer of their write API
 * (@mantle/tabledb/write; the store-brokers lint pins it). Readers keep
 * @mantle/tabledb and resolve a table's files through its row
 * (`tables.storage_path`, `tables.draft_path`; table-storage.ts
 * `draftAbsOf`).
 *
 * Every whole-file write is stage, then flip (store-broker.ts): the new
 * workbook is written under a NEW revision name no row points at, then one
 * short transaction checks the registry row as the caller (on the write role
 * for a login's write: the row rules and the edit check see it), exactly
 * one row, at the revision the stage was built from, and points it at the
 * new file. A refusal removes the stage; what no row points at any more the
 * sweep removes (table-sweep in store-sweep.ts).
 *
 * The one exception: an op batch on an existing draft changes the draft in
 * place, inside a short transaction whose first statement is the check
 * (the draft_rev bump, which takes the row lock): a copy per batch costs a
 * whole workbook (p95 1.7 s at 500,000 rows on the workstation's disk,
 * 2026-10-13), and the batch itself takes milliseconds.
 *
 * Server-only (node:fs, node:sqlite).
 */
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  db,
  inFlipTransaction,
  oneRow,
  revisionToken,
  SQLITE_SIDECARS,
  stageNamedByRow,
  stageThenFlip,
  tables,
} from '@mantle/db';
import {
  applyOpsToFile,
  finalizePublishedFile,
  openTableFile,
  writeDocFile,
} from '@mantle/tabledb/write';
import {
  resolveStoragePath,
  snapshotFile,
  tableDbRoot,
  type ApplyResult,
  type CoerceFn,
  type TableOp,
} from '@mantle/tabledb';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DocArg = Parameters<typeof writeDocFile>[1];
type MetaArg = Parameters<typeof writeDocFile>[2];
type WriteRes = ReturnType<typeof writeDocFile>;
type TableInsert = typeof tables.$inferInsert;
type TableSet = { [K in keyof TableInsert]?: TableInsert[K] | SQL };

/** The registry row a table write starts from. */
export type TableRow = {
  storagePath: string | null;
  draftPath: string | null;
  draftRev: number;
  shapeHash: string | null;
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

/** A new revision's path, relative to TABLE_DB_DIR, beside the table's
 *  others (`<owner>/<node>.r-<token>.sqlite`, a draft `.draft.sqlite`). */
export function tableRevisionPath(ownerId: string, nodeId: string, draft: boolean): string {
  if (!/^[A-Za-z0-9-]+$/.test(ownerId) || !/^[A-Za-z0-9-]+$/.test(nodeId)) {
    throw new Error('table broker: unsafe id for a path');
  }
  return `${ownerId}/${nodeId}.r-${revisionToken()}${draft ? '.draft' : ''}.sqlite`;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A workbook's file name: `<node>[.r-<token>][.draft].sqlite`. */
const TABLE_FILE_NAME = new RegExp(`^(${UUID})(\\.r-[0-9a-z]+)?(\\.draft)?\\.sqlite$`);

/** The node a workbook file name belongs to, or null: not a workbook
 *  revision (a sidecar, the history, anything else). */
export function tableFileNode(name: string): string | null {
  return TABLE_FILE_NAME.exec(name)?.[1] ?? null;
}

/** A draft written before A3b (`<node>.draft.sqlite`, no revision token):
 *  the sweep never removes one (it reports it). */
export function isLegacyDraftName(name: string): boolean {
  const m = TABLE_FILE_NAME.exec(name);
  return m !== null && m[2] === undefined && m[3] !== undefined;
}

/** Every workbook revision of `nodeId` in the folder `dirAbs` (absolute
 *  paths; no sidecars): what a backup keeps (A3b fix round 1, H1: the
 *  revision a dump names may be one a flip has since replaced) and what a
 *  delete removes. */
export function tableRevisionFiles(dirAbs: string, nodeId: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dirAbs);
  } catch {
    return [];
  }
  return names.filter((n) => tableFileNode(n) === nodeId).map((n) => path.join(dirAbs, n));
}

/** A stored path (relative to TABLE_DB_DIR) for an absolute one under it. */
export function tableRelOf(abs: string): string {
  return path.relative(path.resolve(tableDbRoot()), abs).split(path.sep).join('/');
}

/**
 * Stage, then flip, for a table (the store's one way to call the helper):
 * `stage` returns the files it wrote (absolute); a flip known not to have
 * landed removes them, and after any other error they go only when no
 * registry row names one of them (read again as the system).
 */
export function stageThenFlipTable<S extends { files: string[] }, T>(
  stage: () => S | Promise<S>,
  flip: (staged: S) => Promise<T>,
): Promise<T> {
  return stageThenFlip(
    stage,
    flip,
    (staged) => staged.files.forEach(removeWorkbook),
    (staged) => stageNamedByRow({ store: 'tables', paths: staged.files.map(tableRelOf) }),
  );
}

/** A new revision beside the row's published file (its folder: a table
 *  folded in from a member's space keeps its file under that folder). */
export function revisionBesideRow(
  row: TableRow,
  ownerId: string,
  nodeId: string,
  draft: boolean,
): string {
  const rel = tableRevisionPath(ownerId, nodeId, draft);
  if (!row.storagePath) return rel;
  return `${path.posix.dirname(row.storagePath)}/${path.posix.basename(rel)}`;
}

/** Remove a workbook and its SQLite sidecars (a stage the flip refused). */
export function removeWorkbook(abs: string): void {
  rmSync(abs, { force: true });
  for (const s of SQLITE_SIDECARS) rmSync(`${abs}${s}`, { force: true });
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

/** The registry row as the caller reads it (no lock), or null. */
export async function readTableRow(nodeId: string): Promise<TableRow | null> {
  const [r] = await db
    .select({
      storagePath: tables.storagePath,
      draftPath: tables.draftPath,
      draftRev: tables.draftRev,
      shapeHash: tables.shapeHash,
      totalRows: sql<string | null>`${tables.stats}->>'totalRows'`,
      tabCount: sql<number | null>`jsonb_array_length(${tables.stats}->'tabs')`,
    })
    .from(tables)
    .where(eq(tables.nodeId, nodeId))
    .limit(1);
  if (!r) return null;
  return {
    storagePath: r.storagePath,
    draftPath: r.draftPath,
    draftRev: Number(r.draftRev),
    shapeHash: r.shapeHash,
    totalRows: r.totalRows == null ? null : Number(r.totalRows),
    tabCount: r.tabCount == null ? null : Number(r.tabCount),
  };
}

/**
 * THE flip of a table (plan 20.3 step 2): one short transaction whose first
 * statement checks the registry row as the caller and moves it to its next
 * revision, from `expectRev` (none: whatever it is). Exactly one row; no
 * row is a refusal (StoreRefusedError, a 404), a row at another revision a
 * TableRevConflict. `then` runs in the same transaction (the node's row, a
 * history row). Returns the new revision and `then`'s result.
 */
export async function flipTable<R = void>(
  nodeId: string,
  expectRev: number | undefined,
  set: TableSet,
  then?: (tx: Tx, rev: number) => Promise<R>,
): Promise<{ rev: number; out: R }> {
  return db.transaction((tx) =>
    inFlipTransaction(async () => {
      const rows = await tx
        .update(tables)
        .set({ ...set, draftRev: sql`${tables.draftRev} + 1` })
        .where(
          expectRev === undefined
            ? eq(tables.nodeId, nodeId)
            : and(eq(tables.nodeId, nodeId), eq(tables.draftRev, expectRev)),
        )
        .returning({ draftRev: tables.draftRev });
      if (rows.length === 0 && expectRev !== undefined) {
        const [cur] = await tx
          .select({ draftRev: tables.draftRev })
          .from(tables)
          .where(eq(tables.nodeId, nodeId))
          .limit(1);
        if (cur) throw new TableRevConflict(Number(cur.draftRev));
      }
      const rev = Number(oneRow('tables', rows, 'table').draftRev);
      const out = then ? await then(tx, rev) : (undefined as R);
      return { rev, out };
    }),
  );
}

/**
 * Stage, then flip, retried when another write moved the table between the
 * read and the flip (`ifRev` given: that is the caller's conflict instead).
 * `stage` builds the new files from the row it is given and returns them
 * (absolute paths, removed if the flip does not take them); `flip` is the
 * flipTable call. A gone or unreadable table: null.
 */
export async function stagedTableWrite<S extends { files: string[] }, T>(
  nodeId: string,
  opts: { ifRev?: number; tries?: number },
  stage: (row: TableRow) => Promise<S>,
  flip: (row: TableRow, staged: S) => Promise<T>,
): Promise<T | null> {
  const tries = opts.ifRev === undefined ? (opts.tries ?? 3) : 1;
  for (let attempt = 1; ; attempt++) {
    const row = await readTableRow(nodeId);
    if (!row) return null;
    if (opts.ifRev !== undefined && row.draftRev !== opts.ifRev) {
      throw new TableRevConflict(row.draftRev);
    }
    try {
      return await stageThenFlipTable(
        () => stage(row),
        (staged) => flip(row, staged),
      );
    } catch (err) {
      if (err instanceof TableRevConflict && attempt < tries) continue;
      throw err;
    }
  }
}

/** Write a whole workbook as a new revision (`rel` from tableRevisionPath). */
export function stageDoc(rel: string, doc: DocArg, meta: MetaArg): { abs: string; res: WriteRes } {
  const abs = resolveStoragePath(rel);
  return { abs, res: writeDocFile(abs, doc, meta) };
}

/**
 * A new draft revision copied from `fromAbs` (the published workbook, or
 * the draft a restore brings back), with the FTS shadows STRIPPED (drafts
 * never carry them; the promote rebuilds them).
 */
export function stageDraftCopy(fromAbs: string, rel: string): string {
  const abs = resolveStoragePath(rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  checkpoint(fromAbs);
  copyFileSync(fromAbs, abs);
  const draft = openTableFile(abs);
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
  return abs;
}

/** A restored draft: a plain copy of a history file, as a new revision. */
export function stageCopy(fromAbs: string, rel: string): string {
  const abs = resolveStoragePath(rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  copyFileSync(fromAbs, abs);
  return abs;
}

/** An op batch on a staged draft (a first draft is a copy: the batch lands
 *  on it before the flip). */
export function stageOps(abs: string, ops: TableOp[], coerce: CoerceFn): ApplyResult {
  return applyOpsToFile(abs, ops, coerce);
}

/**
 * Publish a draft as a new published revision: a VACUUM INTO copy that
 * reads through the draft's WAL (frames a reader kept un-checkpointed are
 * captured), with its FTS shadows rebuilt. The draft is untouched.
 */
export function stagePromote(draftAbs: string, rel: string): string {
  const abs = resolveStoragePath(rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  snapshotFile(draftAbs, abs);
  finalizePublishedFile(abs);
  return abs;
}

/** A history copy of a published revision (a hard link, else a copy):
 *  revisions are never changed in place, so a link keeps this one. */
export function stageHistoryLink(fromAbs: string, toAbs: string): void {
  mkdirSync(path.dirname(toAbs), { recursive: true });
  try {
    linkSync(fromAbs, toAbs);
  } catch {
    copyFileSync(fromAbs, toAbs);
  }
}

/**
 * The op batch exception (see the header): one short transaction, the check
 * first (the bump, as the caller, exactly one row; a stale `ifRev` is a
 * conflict), then the batch on the draft the row points at, in place, then
 * `then` (the JSONB mirror). Only for a row that HAS a draft file on disk:
 * otherwise 'no_draft', with nothing changed.
 */
export async function opsInPlace<T>(
  nodeId: string,
  ifRev: number | undefined,
  run: (tx: Tx, draftAbs: string, rev: number) => Promise<T>,
): Promise<T | 'no_draft'> {
  return db
    .transaction(async (tx) => {
      const rows = await tx
        .update(tables)
        .set({ draftRev: sql`${tables.draftRev} + 1`, draftUpdatedAt: new Date() })
        .where(eq(tables.nodeId, nodeId))
        .returning({ draftRev: tables.draftRev, draftPath: tables.draftPath });
      const r = oneRow('tables', rows, 'table');
      const rev = Number(r.draftRev);
      if (ifRev !== undefined && rev - 1 !== ifRev) throw new TableRevConflict(rev - 1);
      const draftAbs = r.draftPath ? resolveStoragePath(r.draftPath) : null;
      if (!draftAbs || !existsSync(draftAbs)) {
        // A commit or a discard took the draft since the caller read it, or
        // the row names a draft file that is not there (0283 pointed every
        // row with a draft time at its old name; A3b fix round 1, L1):
        // nothing in place (the bump rolls back); the caller stages a new
        // draft from the published workbook instead.
        throw new NoDraftInPlace();
      }
      return run(tx, draftAbs, rev);
    })
    .catch((err: unknown) => {
      if (err instanceof NoDraftInPlace) return 'no_draft' as const;
      throw err;
    });
}

class NoDraftInPlace extends Error {}

/** The size of a staged file (registry columns). */
export function fileSize(abs: string): number {
  return statSync(abs).size;
}
