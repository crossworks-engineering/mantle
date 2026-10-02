/**
 * Table history (apps first-class plan, Phase 4; docs/tables.md, "History").
 * Tables join the numbered line apps have (`node_snapshots`, node_kind
 * 'table'):
 *
 *  - a `commit` entry: the published workbook a commit replaced. commitTable
 *    keeps it (keepCommitSnapshot) instead of throwing it away; the newest
 *    TABLE_SNAPSHOT_COMMIT_KEEP per table stay.
 *  - a `manual` entry: a copy of the published workbook the owner took;
 *    never pruned, within the owner's snapshot budget (APP_SNAPSHOT_MAX_MB,
 *    shared with the apps).
 *
 * A restore puts an entry's workbook into the table's DRAFT, under the
 * registry lock; the owner reviews it and commits as usual, and that commit
 * keeps the version it replaces, so a restore is undone the same way.
 * Files live under TABLE_DB_DIR/_snapshots/<owner>/<table>/<id>.sqlite and
 * ride the table backup. A commit's copy is a hard link to the file the
 * commit is about to replace (no copy, no wait); that file is never written
 * again once it is replaced.
 *
 * Not kept: app-bound tables (the app is the master, its data has its own
 * history) and commits made in a personal space or under a limited viewer
 * (the history is admin-only).
 *
 * Server-only (node:fs): import via '@mantle/content/table-snapshots'.
 */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import * as path from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodeSnapshots, nodes, tables } from '@mantle/db';
import { currentSpaceScope, currentViewerLevel } from '@mantle/db/viewer';
import { draftPathFor, resolveStoragePath, snapshotFile, tableDbRoot } from '@mantle/tabledb';
import type { TableSnapshot } from '@mantle/client-types';
import { envMbBytes, insertNodeSnapshot, pruneHistoryRows } from './node-snapshot-rows';
import { removeTableFile, withTableRegistryLock } from './table-storage';
import { assertTableWritable } from './tables/shared';
import type { AppHistoryActor } from './apps';

/** Commit entries kept per table (the owner's own are never pruned). */
export const TABLE_SNAPSHOT_COMMIT_KEEP = 20;
/** The default budget for one table's commit entries, in MB
 *  (TABLE_HISTORY_MAX_MB). */
export const TABLE_HISTORY_DEFAULT_MAX_MB = 512;
/** Deleted tables' history goes this long after its newest entry. */
export const TABLE_HISTORY_ORPHAN_DAYS = 30;

/** The snapshot cannot do what was asked; the message says why. */
export class TableSnapshotRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableSnapshotRefusedError';
  }
}

/** The table has an unpublished draft, and a restore would replace it. */
export class TableRestoreDraftError extends Error {
  constructor() {
    super(
      'the table has an unpublished draft, and a restore replaces the draft: pass discard_draft to drop it, or commit it first',
    );
    this.name = 'TableRestoreDraftError';
  }
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function snapshotRelPath(ownerId: string, tableId: string, snapshotId: string): string {
  return path.join('_snapshots', ownerId, tableId, `${snapshotId}.sqlite`);
}

function snapshotAbsPath(rel: string): string {
  const root = tableDbRoot();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root, '_snapshots') + path.sep)) {
    throw new Error(`table snapshot path outside the snapshot folder: ${rel}`);
  }
  return abs;
}

/** History is written by the admin pool only: a personal space or a limited
 *  viewer has no grant on node_snapshots (a refused insert would fail the
 *  commit it rides). */
function historyWritable(): boolean {
  return currentViewerLevel() === 'admin' && currentSpaceScope() === null;
}

/**
 * Keep the published workbook a commit is about to replace, inside the
 * commit's transaction and registry lock. Returns the kept file (the caller
 * removes it if the commit then fails), or null when nothing was kept: no
 * published file yet, or a commit the history does not record.
 */
export async function keepCommitSnapshot(
  tx: DbTx,
  opts: {
    ownerId: string;
    tableId: string;
    publishedAbs: string;
    actor?: AppHistoryActor;
    note?: string | null;
  },
): Promise<string | null> {
  if (!historyWritable() || !existsSync(opts.publishedAbs)) return null;
  const [reg] = await tx
    .select({ version: tables.version })
    .from(tables)
    .where(eq(tables.nodeId, opts.tableId))
    .limit(1);
  const id = randomUUID();
  const rel = snapshotRelPath(opts.ownerId, opts.tableId, id);
  const abs = snapshotAbsPath(rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  try {
    linkSync(opts.publishedAbs, abs);
  } catch {
    // Another filesystem, or links refused: a copy (the file is at rest
    // under the lock, its WAL checkpointed by the commit that wrote it).
    copyFileSync(opts.publishedAbs, abs);
  }
  try {
    await insertNodeSnapshot(tx, {
      id,
      ownerId: opts.ownerId,
      nodeId: opts.tableId,
      nodeKind: 'table',
      trigger: 'commit',
      note: opts.note?.trim().slice(0, 500) || null,
      actor: opts.actor ?? 'owner',
      code: null,
      dbPath: rel,
      dbBytes: statSync(abs).size,
      schemaVersion: reg?.version ?? null,
    });
  } catch (err) {
    rmSync(abs, { force: true });
    throw err;
  }
  return abs;
}

/** Drop this table's commit entries past the newest
 *  TABLE_SNAPSHOT_COMMIT_KEEP, and past TABLE_HISTORY_MAX_MB of files (the
 *  newest stays whatever its size; each kept version is a whole workbook),
 *  files after the rows. One statement: an entry a commit adds meanwhile is
 *  never removed. */
export async function pruneTableCommitSnapshots(tableId: string): Promise<void> {
  const gone = await pruneHistoryRows(
    tableId,
    ['commit'],
    TABLE_SNAPSHOT_COMMIT_KEEP,
    envMbBytes('TABLE_HISTORY_MAX_MB', TABLE_HISTORY_DEFAULT_MAX_MB),
  );
  removeFiles(gone);
}

function removeFiles(paths: (string | null)[]): void {
  for (const rel of paths) {
    if (!rel) continue;
    try {
      rmSync(snapshotAbsPath(rel), { force: true });
    } catch (err) {
      console.error('[table-snapshots] could not remove a snapshot file:', err);
    }
  }
}

/** Built on use, not at import: a test that stands in for @mantle/db need
 *  not know this table. */
const summaryCols = () => ({
  id: nodeSnapshots.id,
  seq: nodeSnapshots.seq,
  trigger: nodeSnapshots.trigger,
  note: nodeSnapshots.note,
  actor: nodeSnapshots.actor,
  createdAt: nodeSnapshots.createdAt,
  schemaVersion: nodeSnapshots.schemaVersion,
  dbBytes: nodeSnapshots.dbBytes,
  dbPath: nodeSnapshots.dbPath,
});

function toSummary(r: {
  id: string;
  seq: number;
  trigger: string;
  note: string | null;
  actor: string;
  createdAt: Date;
  schemaVersion: number | null;
  dbBytes: number | null;
}): TableSnapshot {
  return {
    id: r.id,
    seq: r.seq,
    trigger: r.trigger as TableSnapshot['trigger'],
    note: r.note,
    actor: r.actor as TableSnapshot['actor'],
    createdAt: r.createdAt.toISOString(),
    tableVersion: r.schemaVersion,
    bytes: r.dbBytes,
  };
}

/** The owner's table, with its registry storage path (null: a legacy table
 *  not yet file-backed), or null when it is not this owner's. */
async function ownedTable(
  ownerId: string,
  tableId: string,
): Promise<{ title: string; storagePath: string | null } | null> {
  const [row] = await db
    .select({ title: nodes.title, storagePath: tables.storagePath })
    .from(nodes)
    .innerJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, tableId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  return row ?? null;
}

/** A table's history, newest first. */
export async function listTableSnapshots(
  ownerId: string,
  tableId: string,
  opts: { limit?: number } = {},
): Promise<TableSnapshot[]> {
  const rows = await db
    .select(summaryCols())
    .from(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.nodeId, tableId),
        eq(nodeSnapshots.ownerId, ownerId),
        eq(nodeSnapshots.nodeKind, 'table'),
      ),
    )
    .orderBy(desc(nodeSnapshots.seq))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return rows.map(toSummary);
}

/** One entry with its file's place, or null. */
async function getEntry(
  ownerId: string,
  tableId: string,
  snapshotId: string,
): Promise<(TableSnapshot & { abs: string | null }) | null> {
  const [row] = await db
    .select(summaryCols())
    .from(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.id, snapshotId),
        eq(nodeSnapshots.nodeId, tableId),
        eq(nodeSnapshots.ownerId, ownerId),
        eq(nodeSnapshots.nodeKind, 'table'),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { ...toSummary(row), abs: row.dbPath ? snapshotAbsPath(row.dbPath) : null };
}

/** A snapshot's workbook file (for a download), or null. */
export async function tableSnapshotFile(
  ownerId: string,
  tableId: string,
  snapshotId: string,
): Promise<{ path: string; seq: number } | null> {
  const e = await getEntry(ownerId, tableId, snapshotId);
  if (!e?.abs || !existsSync(e.abs)) return null;
  return { path: e.abs, seq: e.seq };
}

function maxSnapshotBytes(): number {
  return envMbBytes('APP_SNAPSHOT_MAX_MB', 2048);
}

/**
 * Take a snapshot of a table's published workbook now (`manual`: never
 * pruned). Null when the table is not this owner's. Refused for a table that
 * has never been committed to a file, and past the owner's snapshot budget.
 */
export async function createTableSnapshot(
  ownerId: string,
  tableId: string,
  opts: { note?: string | null; actor?: AppHistoryActor } = {},
): Promise<TableSnapshot | null> {
  const table = await ownedTable(ownerId, tableId);
  if (!table) return null;
  if (!table.storagePath) {
    throw new TableSnapshotRefusedError(
      'this table has no committed workbook file yet: commit it once (table_commit), then snapshot it',
    );
  }
  const [used] = await db
    .select({ n: sql<string>`coalesce(sum(${nodeSnapshots.dbBytes}), 0)::bigint` })
    .from(nodeSnapshots)
    .where(eq(nodeSnapshots.ownerId, ownerId));
  const usedBytes = Number(used?.n ?? 0);
  if (usedBytes >= maxSnapshotBytes()) {
    throw new TableSnapshotRefusedError(
      `snapshots already hold ${Math.round(usedBytes / 1048576)} MB of the ${Math.round(maxSnapshotBytes() / 1048576)} MB allowed (APP_SNAPSHOT_MAX_MB): delete old ones first (table_snapshot_delete)`,
    );
  }
  const storagePath = table.storagePath;
  return withTableRegistryLock(tableId, async (tx) => {
    const publishedAbs = resolveStoragePath(storagePath);
    if (!existsSync(publishedAbs)) {
      throw new TableSnapshotRefusedError("the table's workbook file is missing on the server");
    }
    const [reg] = await tx
      .select({ version: tables.version })
      .from(tables)
      .where(eq(tables.nodeId, tableId))
      .limit(1);
    const id = randomUUID();
    const rel = snapshotRelPath(ownerId, tableId, id);
    const abs = snapshotAbsPath(rel);
    snapshotFile(publishedAbs, abs);
    try {
      const row = await insertNodeSnapshot(tx, {
        id,
        ownerId,
        nodeId: tableId,
        nodeKind: 'table',
        trigger: 'manual',
        note: opts.note?.trim().slice(0, 500) || null,
        actor: opts.actor ?? 'owner',
        code: null,
        dbPath: rel,
        dbBytes: statSync(abs).size,
        schemaVersion: reg?.version ?? null,
      });
      return toSummary(row);
    } catch (err) {
      rmSync(abs, { force: true });
      throw err;
    }
  });
}

/**
 * Restore an entry into the table's DRAFT: the owner reviews it, then
 * commits (and that commit keeps the version it replaces). Null when the
 * table or the entry is not there. Refuses (TableRestoreDraftError) over an
 * unpublished draft unless `discardDraft`, an app-bound table
 * (AppBoundTableError), and an entry whose file is gone.
 */
export async function restoreTableSnapshot(
  ownerId: string,
  tableId: string,
  snapshotId: string,
  opts: { discardDraft?: boolean } = {},
): Promise<{ restored: TableSnapshot } | null> {
  const table = await ownedTable(ownerId, tableId);
  if (!table) return null;
  const entry = await getEntry(ownerId, tableId, snapshotId);
  if (!entry) return null;
  await assertTableWritable(tableId);
  if (!entry.abs || !existsSync(entry.abs)) {
    throw new TableSnapshotRefusedError(`v${entry.seq}'s workbook file is missing on the server`);
  }
  const source = entry.abs;
  const done = await withTableRegistryLock(tableId, async (tx, locked) => {
    if (!locked) return false;
    if (!locked.storagePath) {
      throw new TableSnapshotRefusedError('this table has no workbook file to restore into');
    }
    const draftAbs = draftPathFor(resolveStoragePath(locked.storagePath));
    const [reg] = await tx
      .select({ draftData: tables.draftData })
      .from(tables)
      .where(eq(tables.nodeId, tableId))
      .limit(1);
    const hasDraft = existsSync(draftAbs) || (reg?.draftData ?? null) !== null;
    if (hasDraft && !opts.discardDraft) throw new TableRestoreDraftError();
    // The copy lands beside the draft, the old draft's sidecars go (SQLite
    // would replay a stale WAL into the new file), then one rename.
    const tmp = `${draftAbs}.restore-${randomUUID().slice(0, 8)}`;
    try {
      copyFileSync(source, tmp);
      removeTableFile(draftAbs);
      renameSync(tmp, draftAbs);
    } finally {
      rmSync(tmp, { force: true });
    }
    await tx
      .update(tables)
      .set({
        // The file is the draft's only carrier (the JSONB mirror cannot hold
        // a workbook; a stale one would shadow the restore).
        draftData: null,
        draftUpdatedAt: new Date(),
        draftRev: sql`${tables.draftRev} + 1`,
      })
      .where(eq(tables.nodeId, tableId));
    return true;
  });
  if (!done) return null;
  const { abs: _abs, ...restored } = entry;
  return { restored };
}

/** Delete an entry and its file. False when it is not there. */
export async function deleteTableSnapshot(
  ownerId: string,
  tableId: string,
  snapshotId: string,
): Promise<boolean> {
  const gone = await db
    .delete(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.id, snapshotId),
        eq(nodeSnapshots.nodeId, tableId),
        eq(nodeSnapshots.ownerId, ownerId),
        eq(nodeSnapshots.nodeKind, 'table'),
      ),
    )
    .returning({ dbPath: nodeSnapshots.dbPath });
  removeFiles(gone.map((g) => g.dbPath));
  return gone.length > 0;
}

/**
 * The history of tables that are gone (deleted, or a purged personal space),
 * TABLE_HISTORY_ORPHAN_DAYS after its newest entry: rows and files. Part of
 * the nightly `app-trash-purge` sweep. Plain SQL and file removal, no model.
 */
export async function purgeOrphanTableHistory(
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<{ tables: number }> {
  const cutoff = new Date(
    (opts.now ?? new Date()).getTime() - TABLE_HISTORY_ORPHAN_DAYS * 86_400_000,
  );
  const rows = (await db.execute(sql`
    select s.owner_id, s.node_id
      from node_snapshots s
     where s.node_kind = 'table'
       and not exists (select 1 from nodes n where n.id = s.node_id)
     group by s.owner_id, s.node_id
    having max(s.created_at) < ${cutoff.toISOString()}::timestamptz`)) as unknown as {
    owner_id: string;
    node_id: string;
  }[];
  if (opts.dryRun) return { tables: rows.length };
  for (const r of rows) {
    await db
      .delete(nodeSnapshots)
      .where(and(eq(nodeSnapshots.ownerId, r.owner_id), eq(nodeSnapshots.nodeId, r.node_id)));
    rmSync(path.join(tableDbRoot(), '_snapshots', r.owner_id, r.node_id), {
      recursive: true,
      force: true,
    });
  }
  return { tables: rows.length };
}
