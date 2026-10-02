/**
 * App history: versions and snapshots (apps first-class plan, Phase 2;
 * docs/app-authoring-guide.md, "History: versions and snapshots").
 *
 * One numbered line per app in `node_snapshots`. Publish appends a VERSION
 * (code only; apps.ts). This module takes SNAPSHOTS (the code and a copy of
 * the app's SQLite database), lists the line, and restores from it:
 *
 *  - code: the snapshot's code into the draft (preview, then Commit);
 *  - data: the snapshot's database back as the live file;
 *  - full: both, the code going live with the build it ran on.
 *
 * Every restore first takes a `pre_restore` snapshot, so a restore is always
 * one restore away from undone. Database copies live under
 * APP_DB_DIR/_snapshots/<owner>/<app>/<id>.sqlite (APP_DB_DIR is mounted in
 * every process that runs app SQL, and the backup copies the folder).
 *
 * Server-only (node:fs, the SQL child): import via
 * '@mantle/content/app-snapshots'.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { apps, db, nodeSnapshots, nodes, type AppSnapshotCode } from '@mantle/db';
import type { AppRestoreMode, AppSnapshot } from '@mantle/client-types';
import {
  AppRestoreDraftError,
  restoreAppDraft,
  restoreAppLive,
  type AppHistoryActor,
} from './apps';
import {
  AppDbMissingError,
  appDbRoot,
  restoreAppDatabaseFile,
  snapshotAppDatabase,
} from './app-broker';
import { scheduleAppTableExportSync } from './app-table-exports';
import { codeHash, envMbBytes, insertNodeSnapshot, pruneHistoryRows } from './node-snapshot-rows';

export type AppSnapshotTrigger = Exclude<AppSnapshot['trigger'], 'publish'>;

/** Automatic snapshots kept per app (the owner's own are never pruned). */
export const APP_SNAPSHOT_AUTO_KEEP = 20;
/** The default budget for one owner's snapshot copies, in MB
 *  (APP_SNAPSHOT_MAX_MB). */
export const APP_SNAPSHOT_DEFAULT_MAX_MB = 2048;
/** The default budget for one app's automatic snapshot copies, in MB
 *  (APP_SNAPSHOT_AUTO_MAX_MB): about four copies of an app at the
 *  256 MB database cap. */
export const APP_SNAPSHOT_AUTO_DEFAULT_MAX_MB = 1024;

/** The owner's snapshots would pass APP_SNAPSHOT_MAX_MB. */
export class AppSnapshotBudgetError extends Error {
  constructor(usedMb: number, maxMb: number) {
    super(
      `snapshots already hold ${usedMb} MB of the ${maxMb} MB allowed (APP_SNAPSHOT_MAX_MB): delete old snapshots on the app's History tab (or with app_snapshot_delete) first`,
    );
    this.name = 'AppSnapshotBudgetError';
  }
}

/** The snapshot cannot do what was asked: no data to restore, a version
 *  that cannot be deleted, and the like. The message says why. */
export class AppSnapshotRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppSnapshotRefusedError';
  }
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const AUTO_TRIGGERS: AppSnapshotTrigger[] = [
  'pre_restore',
  'pre_schema',
  'pre_delete',
  'pre_import',
  'nightly',
];

function maxSnapshotBytes(): number {
  return envMbBytes('APP_SNAPSHOT_MAX_MB', APP_SNAPSHOT_DEFAULT_MAX_MB);
}

function maxAutoSnapshotBytes(): number {
  return envMbBytes('APP_SNAPSHOT_AUTO_MAX_MB', APP_SNAPSHOT_AUTO_DEFAULT_MAX_MB);
}

/** A snapshot file's place, relative to APP_DB_DIR (what the row keeps). */
function snapshotRelPath(ownerId: string, appId: string, snapshotId: string): string {
  return path.join('_snapshots', ownerId, appId, `${snapshotId}.sqlite`);
}

function snapshotAbsPath(rel: string): string {
  const root = appDbRoot();
  const abs = path.resolve(root, rel);
  // Rows are written by this module only; refuse anything that leaves the root.
  if (!abs.startsWith(path.resolve(root, '_snapshots') + path.sep)) {
    throw new Error(`snapshot path outside the snapshot folder: ${rel}`);
  }
  return abs;
}

/** Hold the app's history lock to the end of `tx`: one snapshot or restore
 *  of an app at a time, across processes. The lock's transaction writes
 *  nothing itself: every row commits in its own transaction, so the undo
 *  snapshot of a restore is kept even when the restore after it fails. */
async function lockAppHistory(tx: DbTx, appId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`app-history:${appId}`}, 0))`,
  );
}

/** The summary columns of a row, computed in SQL so a list never carries the
 *  code itself. */
const summaryCols = {
  id: nodeSnapshots.id,
  seq: nodeSnapshots.seq,
  trigger: nodeSnapshots.trigger,
  note: nodeSnapshots.note,
  actor: nodeSnapshots.actor,
  createdAt: nodeSnapshots.createdAt,
  restoredFrom: nodeSnapshots.restoredFrom,
  dbPath: nodeSnapshots.dbPath,
  dbBytes: nodeSnapshots.dbBytes,
  fileCount: sql<number>`coalesce((select count(*) from jsonb_object_keys(coalesce(${nodeSnapshots.code}->'source'->'files', '{}'::jsonb))), 0)::int`,
  sourceBytes: sql<number>`coalesce((select sum(octet_length(value)) from jsonb_each_text(coalesce(${nodeSnapshots.code}->'source'->'files', '{}'::jsonb))), 0)::bigint`,
  hasDraft: sql<boolean>`coalesce(jsonb_typeof(${nodeSnapshots.code}->'draft') = 'object', false)`,
};

type SummaryRow = {
  id: string;
  seq: number;
  trigger: string;
  note: string | null;
  actor: string;
  createdAt: Date;
  restoredFrom: number | null;
  dbPath: string | null;
  dbBytes: number | null;
  fileCount: number;
  sourceBytes: number | string;
  hasDraft: boolean;
};

function toSummary(r: SummaryRow): AppSnapshot {
  return {
    id: r.id,
    seq: r.seq,
    trigger: r.trigger as AppSnapshot['trigger'],
    kind: r.trigger === 'publish' ? 'version' : 'snapshot',
    note: r.note,
    actor: r.actor as AppSnapshot['actor'],
    createdAt: r.createdAt.toISOString(),
    restoredFrom: r.restoredFrom,
    hasData: r.dbPath !== null,
    dbBytes: r.dbBytes,
    fileCount: Number(r.fileCount),
    sourceBytes: Number(r.sourceBytes),
    hasDraft: r.hasDraft === true,
  };
}

/** The app's code as it stands now, or null when it is not this owner's. */
async function currentCode(ownerId: string, appId: string): Promise<AppSnapshotCode | null> {
  const [row] = await db
    .select({
      title: nodes.title,
      data: nodes.data,
      tags: nodes.tags,
      source: apps.source,
      draft: apps.draftSource,
      manifest: apps.manifest,
      publishedBuild: apps.publishedBuild,
    })
    .from(apps)
    .innerJoin(nodes, eq(nodes.id, apps.nodeId))
    .where(and(eq(apps.nodeId, appId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .limit(1);
  if (!row) return null;
  const d = (row.data ?? {}) as Record<string, unknown>;
  return {
    meta: {
      title: row.title,
      ...(typeof d.icon === 'string' ? { icon: d.icon } : {}),
      ...(typeof d.color === 'string' ? { color: d.color } : {}),
      tags: row.tags ?? [],
    },
    source: row.source,
    draft: row.draft ?? null,
    manifest: row.manifest ?? {},
    publishedBuild: row.publishedBuild ?? null,
  };
}

/** The bytes the owner's snapshot copies take now. */
async function usedSnapshotBytes(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`coalesce(sum(${nodeSnapshots.dbBytes}), 0)::bigint` })
    .from(nodeSnapshots)
    .where(eq(nodeSnapshots.ownerId, ownerId));
  return Number(row?.n ?? 0);
}

/** Take a snapshot while the caller holds the app's history lock. Its row
 *  commits at once, in its own transaction. */
async function snapshotLocked(
  ownerId: string,
  appId: string,
  opts: {
    trigger: AppSnapshotTrigger;
    actor: AppHistoryActor;
    note?: string | null;
    requireData?: boolean;
    withData?: boolean;
    codeOnlyWhenLost?: boolean;
  },
): Promise<AppSnapshot | null> {
  const code = await currentCode(ownerId, appId);
  if (!code) return null;
  if (opts.trigger === 'manual') {
    const used = await usedSnapshotBytes(ownerId);
    const max = maxSnapshotBytes();
    if (used >= max) {
      throw new AppSnapshotBudgetError(Math.round(used / 1048576), Math.round(max / 1048576));
    }
  }
  const id = randomUUID();
  const rel = snapshotRelPath(ownerId, appId, id);
  const abs = snapshotAbsPath(rel);
  let data: Awaited<ReturnType<typeof snapshotAppDatabase>> = null;
  let lost = false;
  if (opts.withData !== false) {
    try {
      data = await snapshotAppDatabase(ownerId, appId, abs);
    } catch (err) {
      if (!(err instanceof AppDbMissingError) || !opts.codeOnlyWhenLost) throw err;
      lost = true;
    }
  }
  if (!data && opts.requireData) return null;
  const note = [
    opts.note?.trim().slice(0, 440),
    lost ? '(code only: the live database file was lost)' : null,
  ]
    .filter(Boolean)
    .join(' ');
  try {
    const row = await db.transaction((tx) =>
      insertNodeSnapshot(tx, {
        id,
        ownerId,
        nodeId: appId,
        nodeKind: 'app',
        trigger: opts.trigger,
        note: note || null,
        actor: opts.actor,
        code,
        sourceHash: codeHash(code.source),
        dbPath: data ? rel : null,
        dbBytes: data?.bytes ?? null,
        schemaVersion: data?.schemaVersion ?? null,
      }),
    );
    return {
      ...toSummary({
        ...row,
        fileCount: Object.keys(code.source.files).length,
        sourceBytes: Object.values(code.source.files).reduce(
          (n, f) => n + Buffer.byteLength(f, 'utf8'),
          0,
        ),
        hasDraft: code.draft !== null,
      }),
    };
  } catch (err) {
    await rm(abs, { force: true });
    throw err;
  }
}

/** Drop this app's automatic snapshots past the newest APP_SNAPSHOT_AUTO_KEEP,
 *  and past APP_SNAPSHOT_AUTO_MAX_MB of copies (the newest stays whatever
 *  its size; the owner's own and the versions are never pruned), files after
 *  the rows. One statement under the app's history lock: nothing taken
 *  meanwhile is removed, and no restore is reading a file it removes. */
async function pruneAutoSnapshots(appId: string): Promise<void> {
  const gone = await db.transaction(async (tx) => {
    await lockAppHistory(tx, appId);
    return pruneHistoryRows(appId, AUTO_TRIGGERS, APP_SNAPSHOT_AUTO_KEEP, maxAutoSnapshotBytes());
  });
  await removeSnapshotFiles(gone);
}

async function removeSnapshotFiles(paths: (string | null)[]): Promise<void> {
  for (const rel of paths) {
    if (!rel) continue;
    try {
      await rm(snapshotAbsPath(rel), { force: true });
    } catch (err) {
      console.error('[app-snapshots] could not remove a snapshot file:', err);
    }
  }
}

/**
 * Take a snapshot of an app: its code (published, and the draft when there is
 * one) and a copy of its database. Null when the app is not this owner's.
 * The owner's own snapshots count against APP_SNAPSHOT_MAX_MB; automatic
 * ones are always taken and the oldest past APP_SNAPSHOT_AUTO_KEEP pruned.
 */
export async function createAppSnapshot(
  ownerId: string,
  appId: string,
  opts: {
    trigger?: AppSnapshotTrigger;
    actor?: AppHistoryActor;
    note?: string | null;
    /** Skip (null) when the app has no database yet: an automatic snapshot
     *  before a schema change has nothing to protect then. */
    requireData?: boolean;
    /** False: keep the code only. */
    withData?: boolean;
    /** Keep the code only when the app's database file is lost (an undo
     *  snapshot must not block the restore that brings the data back),
     *  instead of failing with AppDbMissingError. */
    codeOnlyWhenLost?: boolean;
  } = {},
): Promise<AppSnapshot | null> {
  const trigger = opts.trigger ?? 'manual';
  const snap = await db.transaction(async (tx) => {
    await lockAppHistory(tx, appId);
    return snapshotLocked(ownerId, appId, {
      trigger,
      actor: opts.actor ?? 'owner',
      note: opts.note,
      requireData: opts.requireData === true,
      withData: opts.withData !== false,
      codeOnlyWhenLost: opts.codeOnlyWhenLost === true,
    });
  });
  if (snap && trigger !== 'manual') await pruneAutoSnapshots(appId);
  return snap;
}

/** The app's history, newest first: versions and snapshots, without code. */
export async function listAppSnapshots(
  ownerId: string,
  appId: string,
  opts: { limit?: number } = {},
): Promise<AppSnapshot[]> {
  const rows = await db
    .select(summaryCols)
    .from(nodeSnapshots)
    .where(and(eq(nodeSnapshots.nodeId, appId), eq(nodeSnapshots.ownerId, ownerId)))
    .orderBy(desc(nodeSnapshots.seq))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return rows.map(toSummary);
}

/** One entry with its code, or null. */
export async function getAppSnapshot(
  ownerId: string,
  appId: string,
  snapshotId: string,
): Promise<(AppSnapshot & { code: AppSnapshotCode | null; schemaVersion: number | null }) | null> {
  const [row] = await db
    .select({
      ...summaryCols,
      code: nodeSnapshots.code,
      schemaVersion: nodeSnapshots.schemaVersion,
    })
    .from(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.id, snapshotId),
        eq(nodeSnapshots.nodeId, appId),
        eq(nodeSnapshots.ownerId, ownerId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { ...toSummary(row), code: row.code ?? null, schemaVersion: row.schemaVersion };
}

/** The absolute path of a snapshot's database copy (for a download), or
 *  null when it holds no data. */
export async function appSnapshotFile(
  ownerId: string,
  appId: string,
  snapshotId: string,
): Promise<{ path: string; bytes: number | null; seq: number } | null> {
  const [row] = await db
    .select({
      dbPath: nodeSnapshots.dbPath,
      dbBytes: nodeSnapshots.dbBytes,
      seq: nodeSnapshots.seq,
    })
    .from(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.id, snapshotId),
        eq(nodeSnapshots.nodeId, appId),
        eq(nodeSnapshots.ownerId, ownerId),
        isNotNull(nodeSnapshots.dbPath),
      ),
    )
    .limit(1);
  if (!row?.dbPath) return null;
  return { path: snapshotAbsPath(row.dbPath), bytes: row.dbBytes, seq: row.seq };
}

/** Change a snapshot's note. False when it is not there. */
export async function setAppSnapshotNote(
  ownerId: string,
  appId: string,
  snapshotId: string,
  note: string | null,
): Promise<boolean> {
  const rows = await db
    .update(nodeSnapshots)
    .set({ note: note?.trim().slice(0, 500) || null })
    .where(
      and(
        eq(nodeSnapshots.id, snapshotId),
        eq(nodeSnapshots.nodeId, appId),
        eq(nodeSnapshots.ownerId, ownerId),
      ),
    )
    .returning({ id: nodeSnapshots.id });
  return rows.length > 0;
}

/** Delete a snapshot and its database copy. A version (what a publish made
 *  live) stays: it is the app's history. False when it is not there. */
export async function deleteAppSnapshot(
  ownerId: string,
  appId: string,
  snapshotId: string,
): Promise<boolean> {
  const snap = await getAppSnapshot(ownerId, appId, snapshotId);
  if (!snap) return false;
  if (snap.kind === 'version') {
    throw new AppSnapshotRefusedError(
      `v${snap.seq} is a version (what a publish made live) and stays in the app's history; only snapshots can be deleted`,
    );
  }
  const gone = await db
    .delete(nodeSnapshots)
    .where(eq(nodeSnapshots.id, snapshotId))
    .returning({ dbPath: nodeSnapshots.dbPath });
  await removeSnapshotFiles(gone.map((g) => g.dbPath));
  return gone.length > 0;
}

/** What a restore did. */
export type AppRestoreResult = {
  mode: AppRestoreMode;
  restored: AppSnapshot;
  /** The snapshot taken first, to undo this restore with. */
  undo: AppSnapshot | null;
  /** Where the code went: the draft (preview, then Commit) or live. */
  code: 'draft' | 'live' | null;
  /** Code into the draft only: the tools the restored code declared, when
   *  they differ from the app's. NOT granted (the app has one allowlist,
   *  the live app's): the owner grants them with app_tools_set. */
  declaredTools: string[] | null;
};

function sameTools(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = new Set(a ?? []);
  const y = new Set(b ?? []);
  return x.size === y.size && [...x].every((t) => y.has(t));
}

/**
 * Restore an app from an entry on its history line (`mode`: code into the
 * draft, the data, or both live). Takes a `pre_restore` snapshot first.
 * Refuses (AppSnapshotRefusedError) a data restore from a version, which
 * holds no data, and (AppRestoreDraftError) a code restore over an
 * unpublished draft unless `discardDraft`.
 */
export async function restoreAppSnapshot(
  ownerId: string,
  appId: string,
  snapshotId: string,
  opts: {
    mode: AppRestoreMode;
    discardDraft?: boolean;
    actor?: AppHistoryActor;
    /** Tests only: the drain before the file swap. */
    drainMs?: number;
  },
): Promise<AppRestoreResult | null> {
  const snap = await getAppSnapshot(ownerId, appId, snapshotId);
  if (!snap) return null;
  const { mode } = opts;
  const actor = opts.actor ?? 'owner';
  const wantsData = mode === 'data' || mode === 'full';
  const wantsCode = mode === 'code' || mode === 'full';
  if (wantsData && !snap.hasData) {
    throw new AppSnapshotRefusedError(
      `v${snap.seq} holds no data (it is ${snap.kind === 'version' ? 'a version: the code a publish made live' : 'a snapshot of an app that had no database yet'}); restore its code, or pick a snapshot with data`,
    );
  }
  if (wantsCode && !snap.code) {
    throw new AppSnapshotRefusedError(`v${snap.seq} holds no code to restore`);
  }

  const result = await db.transaction(async (tx) => {
    await lockAppHistory(tx, appId);
    if (wantsCode && !opts.discardDraft) {
      // Refuse before the undo snapshot and any swap: nothing changes.
      const now = await currentCode(ownerId, appId);
      if (now?.draft) throw new AppRestoreDraftError();
    }
    // A lost live file is what a data restore is for: the undo snapshot
    // keeps the code then, and the restore goes on (apps audit 2026-10-02,
    // item 4).
    const undo = await snapshotLocked(ownerId, appId, {
      trigger: 'pre_restore',
      actor,
      note: `before restoring v${snap.seq} (${mode})`,
      codeOnlyWhenLost: true,
    });
    if (wantsData) {
      const file = await appSnapshotFile(ownerId, appId, snapshotId);
      if (!file) throw new AppSnapshotRefusedError(`v${snap.seq} holds no data`);
      await restoreAppDatabaseFile(ownerId, appId, file.path, snap.schemaVersion ?? 0, {
        ...(opts.drainMs !== undefined ? { drainMs: opts.drainMs } : {}),
      });
    }
    let code: AppRestoreResult['code'] = null;
    let declaredTools: string[] | null = null;
    if (wantsCode && snap.code) {
      const build = snap.code.publishedBuild;
      if (mode === 'full' && build?.ok) {
        await restoreAppLive(ownerId, appId, { ...snap.code, publishedBuild: build }, snap.seq, {
          discardDraft: true,
          actor,
        });
        code = 'live';
      } else {
        // A code restore, or a full one from an app that had never been
        // published: the code goes to the draft.
        await restoreAppDraft(ownerId, appId, snap.code, snap.seq, { discardDraft: true });
        code = 'draft';
        // The manifest did not change: it is the live app's.
        const live = await currentCode(ownerId, appId);
        if (!sameTools(snap.code.manifest.toolSlugs, live?.manifest.toolSlugs)) {
          declaredTools = snap.code.manifest.toolSlugs ?? [];
        }
      }
    }
    return { mode, restored: snap, undo, code, declaredTools };
  });
  if (wantsData) scheduleAppTableExportSync(ownerId, appId);
  await pruneAutoSnapshots(appId);
  const { code: _code, schemaVersion: _sv, ...restored } = result.restored;
  return { ...result, restored };
}
