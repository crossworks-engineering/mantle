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
 * ride the table backup (hard-linked, history-files.ts). A commit's copy is a
 * hard link to the file the commit is about to replace (no copy, no wait);
 * that file is never written again once it is replaced. The other copies run
 * off the event loop (a SQL child, or an async copy).
 *
 * Not kept: app-bound tables (the app is the master, its data has its own
 * history) and commits made in a personal space or under a limited viewer
 * (the history is admin-only).
 *
 * Server-only (node:fs): import via '@mantle/content/table-snapshots'.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, inFlipTransaction, nodeSnapshots, nodes, StoreRefusedError, tables } from '@mantle/db';
import { assertItemRight } from '@mantle/db';
import { currentSpaceScope, isSystemScope } from '@mantle/db/viewer';
import { resolveStoragePath, tableDbRoot } from '@mantle/tabledb';
import { defineDomainError } from '@mantle/std';
import type { TableSnapshot } from '@mantle/client-types';
import { copySqliteFile, SnapshotNotRecorded, stageThenFlipSnapshot } from './snapshot-broker';
import { envNumDefault } from '@mantle/config';
import { envMbBytes, insertNodeSnapshot, pruneHistoryRows } from './node-snapshot-rows';

import {
  flipTable,
  revisionBesideRow,
  stageCopy,
  stagedTableWrite,
  stageHistoryLink,
} from './table-broker';
import { assertTableWritable } from './tables/shared';
import type { AppHistoryActor } from './apps';

/** Commit entries kept per table (the owner's own are never pruned). */
export const TABLE_SNAPSHOT_COMMIT_KEEP = 20;
/** The default budget for one table's commit entries, in MB
 *  (TABLE_HISTORY_MAX_MB). */
export const TABLE_HISTORY_DEFAULT_MAX_MB = envNumDefault('TABLE_HISTORY_MAX_MB');
/** Deleted tables' history goes this long after its newest entry. */
export const TABLE_HISTORY_ORPHAN_DAYS = 30;

/** The snapshot cannot do what was asked; the message says why. */
export class TableSnapshotRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableSnapshotRefusedError';
  }
}

// The one error answer (A10 part 2, @mantle/std domain-errors.ts): what
// the routes answered by hand.
defineDomainError(TableSnapshotRefusedError, {
  reason: 'the snapshot cannot do what was asked; the message says why',
  status: 409,
});

/** The table has an unpublished draft, and a restore would replace it. */
export class TableRestoreDraftError extends Error {
  constructor() {
    super(
      'the table has an unpublished draft, and a restore replaces the draft: pass discard_draft to drop it, or commit it first',
    );
    this.name = 'TableRestoreDraftError';
  }
}

defineDomainError(TableRestoreDraftError, {
  reason: 'a restore would replace unpublished work; the message says how to confirm',
  status: 409,
  body: (e) => ({ error: e.message, reason: 'draft' }),
});

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
  return isSystemScope() && currentSpaceScope() === null;
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A commit's history copy, staged before the commit's flip. */
export type StagedCommitSnapshot = { id: string; rel: string; abs: string };

/**
 * Stage the history copy of the published workbook a commit is about to
 * replace (plan 20.3: before the commit's one short transaction): a hard
 * link, else a copy, under the history folder. Null when nothing is kept:
 * no published file yet, or a commit the history does not record. The
 * commit removes it if its flip does not land; the row goes in with the
 * flip (recordCommitSnapshot).
 */
export function stageCommitSnapshot(opts: {
  ownerId: string;
  tableId: string;
  publishedAbs: string;
}): StagedCommitSnapshot | null {
  if (!historyWritable() || !existsSync(opts.publishedAbs)) return null;
  const id = randomUUID();
  const rel = snapshotRelPath(opts.ownerId, opts.tableId, id);
  const abs = snapshotAbsPath(rel);
  stageHistoryLink(opts.publishedAbs, abs);
  return { id, rel, abs };
}

/** The staged copy's history row, inside the commit's flip. `version`: the
 *  table's version before the commit (the one the copy holds). */
export async function recordCommitSnapshot(
  tx: DbTx,
  staged: StagedCommitSnapshot,
  opts: {
    ownerId: string;
    tableId: string;
    version: number | null;
    actor?: AppHistoryActor;
    note?: string | null;
  },
): Promise<void> {
  await insertNodeSnapshot(tx, {
    id: staged.id,
    ownerId: opts.ownerId,
    nodeId: opts.tableId,
    nodeKind: 'table',
    trigger: 'commit',
    note: opts.note?.trim().slice(0, 500) || null,
    actor: opts.actor ?? 'owner',
    code: null,
    dbPath: staged.rel,
    dbBytes: statSync(staged.abs).size,
    schemaVersion: opts.version,
  });
}

/** Drop this table's commit entries past the newest
 *  TABLE_SNAPSHOT_COMMIT_KEEP, and past TABLE_HISTORY_MAX_MB of files (the
 *  newest stays whatever its size; each kept version is a whole workbook).
 *  One statement: an entry a commit adds meanwhile is never removed. Rows
 *  only: each row's trigger records its file for the store sweep (A3b part
 *  2, store_tombstones). */
export async function pruneTableCommitSnapshots(tableId: string): Promise<void> {
  await pruneHistoryRows(
    tableId,
    ['commit'],
    TABLE_SNAPSHOT_COMMIT_KEEP,
    envMbBytes('TABLE_HISTORY_MAX_MB'),
  );
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

/** The owner's table's title, or null when it is not this owner's: the
 *  history routes' existence check, without loading the table itself (apps
 *  audit 2026-10-02, low). */
export async function tableTitle(ownerId: string, tableId: string): Promise<string | null> {
  return (await ownedTable(ownerId, tableId))?.title ?? null;
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
  return envMbBytes('APP_SNAPSHOT_MAX_MB');
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
  // Edit first (the cheap rights read, pre-check removal fix round A):
  // before the copy.
  await assertItemRight(tableId, 'edit');
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
  // The snapshot broker (A3b part 2, plan 20.3): the copy is staged first,
  // outside any transaction (it used to be taken inside the registry
  // lock's transaction, held across the whole copy); then one short
  // transaction locks the registry row, checks it still names the file
  // copied (a commit may have replaced it meanwhile: taken again, twice at
  // most) and writes the history row naming the copy.
  let storagePath = table.storagePath;
  for (let attempt = 1; ; attempt++) {
    const from = storagePath;
    try {
      return await stageThenFlipSnapshot(
        async () => {
          const publishedAbs = resolveStoragePath(from);
          if (!existsSync(publishedAbs)) {
            throw new TableSnapshotRefusedError(
              "the table's workbook file is missing on the server",
            );
          }
          const id = randomUUID();
          const rel = snapshotRelPath(ownerId, tableId, id);
          const abs = snapshotAbsPath(rel);
          // In a SQL child, off the event loop (apps audit 2026-10-02, item 14).
          const bytes = await copySqliteFile(publishedAbs, abs);
          return { id, rel, abs, bytes };
        },
        (st) =>
          db.transaction((tx) =>
            inFlipTransaction(async () => {
              const [reg] = await tx
                .select({ version: tables.version, storagePath: tables.storagePath })
                .from(tables)
                .where(eq(tables.nodeId, tableId))
                .for('update')
                .limit(1);
              if (!reg) throw new StoreRefusedError('snapshots', 'table', 0);
              if (reg.storagePath !== from) throw new SnapshotNotRecorded('moved');
              const row = await insertNodeSnapshot(tx, {
                id: st.id,
                ownerId,
                nodeId: tableId,
                nodeKind: 'table',
                trigger: 'manual',
                note: opts.note?.trim().slice(0, 500) || null,
                actor: opts.actor ?? 'owner',
                code: null,
                dbPath: st.rel,
                dbBytes: st.bytes,
                schemaVersion: reg.version ?? null,
              });
              return toSummary(row);
            }),
          ),
      );
    } catch (err) {
      if (err instanceof SnapshotNotRecorded && attempt < 3) {
        const again = await ownedTable(ownerId, tableId);
        if (!again?.storagePath) return null;
        storagePath = again.storagePath;
        continue;
      }
      if (err instanceof StoreRefusedError) return null;
      throw err;
    }
  }
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
  // Edit first (the cheap rights read, pre-check removal fix round A):
  // before the copy, and the same refusal whether a draft is there or not.
  await assertItemRight(tableId, 'edit');
  const entry = await getEntry(ownerId, tableId, snapshotId);
  if (!entry) return null;
  await assertTableWritable(tableId);
  if (!entry.abs || !existsSync(entry.abs)) {
    throw new TableSnapshotRefusedError(`v${entry.seq}'s workbook file is missing on the server`);
  }
  const source = entry.abs;
  // The store broker (A3b, plan 20.3): the copy is staged as a new draft
  // revision, then one short transaction checks the row (at the revision
  // read) and points the draft at it.
  const done = await stagedTableWrite(
    tableId,
    {},
    async (row) => {
      if (!row.storagePath) {
        throw new TableSnapshotRefusedError('this table has no workbook file to restore into');
      }
      const [reg] = await db
        .select({ draftData: tables.draftData })
        .from(tables)
        .where(eq(tables.nodeId, tableId))
        .limit(1);
      const hasDraft = row.draftPath !== null || (reg?.draftData ?? null) !== null;
      if (hasDraft && !opts.discardDraft) throw new TableRestoreDraftError();
      // Beside the row's published file (a table folded in from a member's
      // space keeps its files in that folder; A3b fix round 1, M4).
      const rel = revisionBesideRow(row, ownerId, tableId, true);
      return { files: [stageCopy(source, rel)], rel };
    },
    async (row, s) => {
      await flipTable(tableId, row.draftRev, {
        // The file is the draft's only carrier (the JSONB mirror cannot hold
        // a workbook; a stale one would shadow the restore).
        draftPath: s.rel,
        draftData: null,
        draftUpdatedAt: new Date(),
      });
      return true;
    },
  ).catch((err: unknown) => {
    if (err instanceof StoreRefusedError) return null;
    throw err;
  });
  if (!done) return null;
  const { abs: _abs, ...restored } = entry;
  return { restored };
}

/** Delete an entry and its file. False when it is not there. The row goes
 *  now; its trigger records the file, which the store sweep removes a grace
 *  period later (A3b part 2). */
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
    .returning({ id: nodeSnapshots.id });
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
  // Rows only: each row's trigger records its file, which the store sweep
  // removes a grace period later (A3b part 2, store_tombstones); a file
  // there that no row ever named stays, reported.
  for (const r of rows) {
    await db
      .delete(nodeSnapshots)
      .where(and(eq(nodeSnapshots.ownerId, r.owner_id), eq(nodeSnapshots.nodeId, r.node_id)));
  }
  return { tables: rows.length };
}
