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
import * as path from 'node:path';
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import {
  appDatabases,
  apps,
  assertItemRight,
  db,
  inFlipTransaction,
  nodeSnapshots,
  nodes,
  type AppSnapshotCode,
  itemHomeSql,
  snapshotBytesUsed,
  snapshotHomeMeta,
} from '@mantle/db';
import { defineDomainError } from '@mantle/std';
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
import { lockAppHistory } from './app-history-lock';
import { SnapshotNotRecorded, stageThenFlipSnapshot } from './snapshot-broker';
import { scheduleAppTableExportSync } from './app-table-exports';
import { envNumDefault } from '@mantle/config';
import { codeHash, envMbBytes, insertNodeSnapshot, pruneHistoryRows } from './node-snapshot-rows';

export type AppSnapshotTrigger = Exclude<AppSnapshot['trigger'], 'publish'>;

/** Automatic snapshots kept per app (the owner's own are never pruned). */
export const APP_SNAPSHOT_AUTO_KEEP = 20;
/** The default budget for one owner's snapshot copies, in MB
 *  (APP_SNAPSHOT_MAX_MB). */
export const APP_SNAPSHOT_DEFAULT_MAX_MB = envNumDefault('APP_SNAPSHOT_MAX_MB');
/** The default budget for one app's automatic snapshot copies, in MB
 *  (APP_SNAPSHOT_AUTO_MAX_MB): about four copies of an app at the
 *  256 MB database cap. */
export const APP_SNAPSHOT_AUTO_DEFAULT_MAX_MB = envNumDefault('APP_SNAPSHOT_AUTO_MAX_MB');

/** The `pre_mcp_write` snapshots kept per app: a day of hourly ones. They
 *  are pruned on their own line (M1 audit, medium 2), so writes over MCP can
 *  never push out a nightly, pre-schema, pre-restore or pre-import one. */
export const APP_SNAPSHOT_MCP_KEEP = 24;
/** The default budget for one app's `pre_mcp_write` copies, in MB
 *  (APP_SNAPSHOT_MCP_MAX_MB), apart from the other automatic ones. */
export const APP_SNAPSHOT_MCP_DEFAULT_MAX_MB = envNumDefault('APP_SNAPSHOT_MCP_MAX_MB');

/** The owner's own snapshots would pass APP_SNAPSHOT_MAX_MB. A member
 *  deletes their own with my_app_snapshot_delete (access matrix N6), so
 *  their answer names that tool. */
export class AppSnapshotBudgetError extends Error {
  constructor(usedMb: number, maxMb: number, opts: { member?: boolean } = {}) {
    super(
      opts.member
        ? `your snapshots already hold ${usedMb} MB of the ${maxMb} MB allowed (APP_SNAPSHOT_MAX_MB): delete old snapshots you took with my_app_snapshot_delete (my_app_snapshot_list shows them on each app), then take this one`
        : `snapshots already hold ${usedMb} MB of the ${maxMb} MB allowed (APP_SNAPSHOT_MAX_MB): delete old snapshots on the app's History tab (or with app_snapshot_delete) first`,
    );
    this.name = 'AppSnapshotBudgetError';
  }
}

// The one error answer (A10 part 2, @mantle/std domain-errors.ts): what
// the routes answered by hand.
defineDomainError(AppSnapshotBudgetError, {
  reason: 'the snapshots would pass their budget; the message says what to delete',
  status: 409,
  body: (e) => ({ error: e.message, reason: 'budget' }),
});

/** The snapshot cannot do what was asked: no data to restore, a version
 *  that cannot be deleted, and the like. The message says why. */
export class AppSnapshotRefusedError extends Error {
  /** `no-data` from a restore (the route's 409 says it), else none. */
  constructor(
    message: string,
    readonly reason?: 'no-data',
  ) {
    super(message);
    this.name = 'AppSnapshotRefusedError';
  }
}

defineDomainError(AppSnapshotRefusedError, {
  reason: 'the snapshot cannot do what was asked; the message says why',
  status: 409,
  body: (e) => (e.reason ? { error: e.message, reason: e.reason } : { error: e.message }),
});

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Where a read runs: the pool, or the transaction that holds the app's
 *  history lock (never a second connection under it). */
type Q = Pick<typeof db, 'select' | 'execute'>;

/** The automatic snapshots pruned together (APP_SNAPSHOT_AUTO_KEEP,
 *  APP_SNAPSHOT_AUTO_MAX_MB). `pre_mcp_write` is pruned on its own line. */
const AUTO_TRIGGERS: AppSnapshotTrigger[] = [
  'pre_restore',
  'pre_schema',
  'pre_delete',
  'pre_import',
  'nightly',
];
const MCP_TRIGGERS: AppSnapshotTrigger[] = ['pre_mcp_write'];

function maxSnapshotBytes(): number {
  return envMbBytes('APP_SNAPSHOT_MAX_MB');
}

function maxAutoSnapshotBytes(): number {
  return envMbBytes('APP_SNAPSHOT_AUTO_MAX_MB');
}

function maxMcpSnapshotBytes(): number {
  return envMbBytes('APP_SNAPSHOT_MCP_MAX_MB');
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

/** The summary columns of a row: a list never carries the code itself, and
 *  never reads it either (the sizes are kept on the row, migration 0224). */
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
  fileCount: sql<number>`coalesce(${nodeSnapshots.fileCount}, 0)`,
  sourceBytes: sql<number>`coalesce(${nodeSnapshots.sourceBytes}, 0)`,
  hasDraft: sql<boolean>`coalesce(${nodeSnapshots.hasDraft}, false)`,
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
async function currentCode(
  ownerId: string,
  appId: string,
  q: Q = db,
): Promise<AppSnapshotCode | null> {
  const [row] = await q
    .select({
      title: nodes.title,
      data: nodes.data,
      tags: nodes.tags,
      source: apps.source,
      draft: apps.draftSource,
      manifest: apps.manifest,
      publishedBuild: apps.publishedBuild,
      authorLevel: apps.authorLevel,
      home: itemHomeSql(),
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
      ...(row.authorLevel === 'team' ? { authorLevel: 'team' as const } : {}),
      // Where it lives: a deleted app's purge and restore are checked
      // against it (W6a fix round 1, M1).
      ...snapshotHomeMeta(row.home),
    },
    source: row.source,
    draft: row.draft ?? null,
    manifest: row.manifest ?? {},
    publishedBuild: row.publishedBuild ?? null,
  };
}

/**
 * The bytes the owner's OWN snapshot copies take now: the manual ones
 * (APP_SNAPSHOT_MAX_MB), never an automatic one, which is pruned on its
 * own line per app (access matrix L22). A member's budget counts the
 * snapshots that member took in their space; the brain's counts the brain's,
 * never the member-era ones an Accept or an admin's delete moved in
 * (access matrix N7: those were within the member's budget when taken).
 */
async function usedSnapshotBytes(
  ownerId: string,
  member: boolean,
  q: Q = db,
  memberLoginId?: string | null,
): Promise<number> {
  // Brain-wide (mantle_snapshot_bytes, F4 fix round 2): the scope reads only
  // the history of the apps it reads, so its sum was short and the budget
  // let more through. A member's budget is that member's own (audit B6): a
  // personal space has one member today, and the refusal says "your
  // snapshots".
  return snapshotBytesUsed(ownerId, {
    manualOnly: true,
    member,
    loginId: member && memberLoginId ? memberLoginId : null,
    q,
  });
}

type SnapshotOpts = {
  trigger: AppSnapshotTrigger;
  actor: AppHistoryActor;
  actorLoginId?: string | null;
  note?: string | null;
  requireData?: boolean;
  withData?: boolean;
  codeOnlyWhenLost?: boolean;
};

/** A snapshot's database copy, staged before its row (the snapshot
 *  broker): its id, its paths, and the file it was copied from. */
type StagedAppSnapshot = {
  id: string;
  rel: string;
  abs: string | null;
  data: { bytes: number; schemaVersion: number; storagePath: string; writeSeq: number } | null;
  lost: boolean;
};

/** Past the owner's (or the member's) snapshot budget: refused. */
async function assertSnapshotBudget(ownerId: string, opts: SnapshotOpts, q: Q): Promise<void> {
  if (opts.trigger !== 'manual') return;
  const member = opts.actor === 'member';
  const used = await usedSnapshotBytes(ownerId, member, q, opts.actorLoginId);
  const max = maxSnapshotBytes();
  if (used >= max) {
    throw new AppSnapshotBudgetError(Math.round(used / 1048576), Math.round(max / 1048576), {
      member,
    });
  }
}

/** Stage a snapshot's database copy (the snapshot broker, A3b part 2): a
 *  new file under the snapshot's own id, outside any transaction. */
async function stageAppSnapshot(
  ownerId: string,
  appId: string,
  opts: SnapshotOpts,
): Promise<StagedAppSnapshot> {
  const id = randomUUID();
  const rel = snapshotRelPath(ownerId, appId, id);
  const abs = snapshotAbsPath(rel);
  let data: StagedAppSnapshot['data'] = null;
  let lost = false;
  if (opts.withData !== false) {
    try {
      data = await snapshotAppDatabase(ownerId, appId, abs);
    } catch (err) {
      if (!(err instanceof AppDbMissingError) || !opts.codeOnlyWhenLost) throw err;
      lost = true;
    }
  }
  return { id, rel, abs: data ? abs : null, data, lost };
}

/** The staged snapshot's row, inside the flip (under the app's history
 *  lock): the code as it stands, the copy's path and size. Not recorded
 *  (taken again) when the app's database moved on since the copy: a restore
 *  put another file in place, a schema change ran, or (unless
 *  `allowWrites`, the last try) a write landed, so the code read now could
 *  be newer than the data copied (fix round 1, L6). */
async function recordAppSnapshot(
  tx: DbTx,
  ownerId: string,
  appId: string,
  opts: SnapshotOpts,
  staged: StagedAppSnapshot,
  allowWrites: boolean,
): Promise<AppSnapshot | null> {
  const code = await currentCode(ownerId, appId, tx);
  if (!code) return null;
  await assertSnapshotBudget(ownerId, opts, tx);
  if (staged.data) {
    const [reg] = await tx
      .select({
        storagePath: appDatabases.storagePath,
        schemaVersion: appDatabases.schemaVersion,
        writeSeq: sql<number>`${appDatabases.writeSeq}::float8`,
      })
      .from(appDatabases)
      .where(and(eq(appDatabases.appNodeId, appId), eq(appDatabases.ownerId, ownerId)))
      .limit(1);
    if (
      !reg ||
      reg.storagePath !== staged.data.storagePath ||
      reg.schemaVersion !== staged.data.schemaVersion ||
      (!allowWrites && Number(reg.writeSeq) !== staged.data.writeSeq)
    ) {
      throw new SnapshotNotRecorded('moved');
    }
  }
  const note = [
    opts.note?.trim().slice(0, 440),
    staged.lost ? '(code only: the live database file was lost)' : null,
  ]
    .filter(Boolean)
    .join(' ');
  const row = await insertNodeSnapshot(tx, {
    id: staged.id,
    ownerId,
    nodeId: appId,
    nodeKind: 'app',
    trigger: opts.trigger,
    note: note || null,
    actor: opts.actor,
    actorLoginId: opts.actorLoginId ?? null,
    code,
    sourceHash: codeHash(code.source),
    dbPath: staged.data ? staged.rel : null,
    dbBytes: staged.data?.bytes ?? null,
    schemaVersion: staged.data?.schemaVersion ?? null,
  });
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
}

/** A snapshot with this trigger taken at or after `since`. */
async function snapshotSince(
  q: Q,
  appId: string,
  trigger: AppSnapshotTrigger,
  since: Date,
): Promise<boolean> {
  const [recent] = await q
    .select({ id: nodeSnapshots.id })
    .from(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.nodeId, appId),
        eq(nodeSnapshots.trigger, trigger),
        gte(nodeSnapshots.createdAt, since),
      ),
    )
    .limit(1);
  return recent !== undefined;
}

/** Drop this app's automatic snapshots past the newest APP_SNAPSHOT_AUTO_KEEP,
 *  and past APP_SNAPSHOT_AUTO_MAX_MB of copies (the newest stays whatever
 *  its size; the owner's own and the versions are never pruned). Rows only:
 *  each row's trigger records its file for the store sweep (A3b part 2). The `pre_mcp_write` ones are their own line
 *  (APP_SNAPSHOT_MCP_KEEP, APP_SNAPSHOT_MCP_MAX_MB): an MCP write prunes
 *  only them, and never counts against the others (M1 audit, medium 2).
 *  One statement under the app's history lock, on the lock's transaction:
 *  nothing taken meanwhile is removed, and no restore is reading a file it
 *  removes. */
async function pruneAutoSnapshots(appId: string, trigger: AppSnapshotTrigger): Promise<void> {
  const mcp = MCP_TRIGGERS.includes(trigger);
  await db.transaction(async (tx) => {
    await lockAppHistory(tx, appId);
    return mcp
      ? pruneHistoryRows(appId, MCP_TRIGGERS, APP_SNAPSHOT_MCP_KEEP, maxMcpSnapshotBytes(), tx)
      : pruneHistoryRows(appId, AUTO_TRIGGERS, APP_SNAPSHOT_AUTO_KEEP, maxAutoSnapshotBytes(), tx);
  });
}

/**
 * Take a snapshot of an app: its code (published, and the draft when there is
 * one) and a copy of its database. Null when the app is not this owner's.
 * Only the owner's own (manual) snapshots count against APP_SNAPSHOT_MAX_MB;
 * automatic ones are always taken, never count there, and the oldest past
 * APP_SNAPSHOT_AUTO_KEEP are pruned.
 */
export async function createAppSnapshot(
  ownerId: string,
  appId: string,
  opts: {
    trigger?: AppSnapshotTrigger;
    actor?: AppHistoryActor;
    /** The member a 'member' row names (team apps Phase 3). */
    actorLoginId?: string | null;
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
    /** Skip (null) when a snapshot with the same trigger was taken at or
     *  after this time. Checked under the app's history lock, so two
     *  callers at once take one snapshot, not two (the hourly
     *  `pre_mcp_write`). */
    onlyIfNoneSince?: Date;
  } = {},
): Promise<AppSnapshot | null> {
  const trigger = opts.trigger ?? 'manual';
  const o: SnapshotOpts = {
    trigger,
    actor: opts.actor ?? 'owner',
    actorLoginId: opts.actorLoginId ?? null,
    note: opts.note,
    requireData: opts.requireData === true,
    withData: opts.withData !== false,
    codeOnlyWhenLost: opts.codeOnlyWhenLost === true,
  };
  // Cheap answers before any copy (each asked again in the flip, under the
  // app's history lock): not this owner's app, a snapshot already taken
  // since, past the budget.
  if (!(await currentCode(ownerId, appId))) return null;
  // A snapshot asked for (app_snapshot_create): edit of the app first (the
  // cheap rights read, pre-check removal fix round A), before a copy of up
  // to 256 MB. An automatic one rides a write its caller already asked.
  if (trigger === 'manual') await assertItemRight(appId, 'edit');
  if (opts.onlyIfNoneSince && (await snapshotSince(db, appId, trigger, opts.onlyIfNoneSince))) {
    return null;
  }
  await assertSnapshotBudget(ownerId, o, db);
  // The snapshot broker (A3b part 2, plan 20.3): the database copy is
  // staged first, outside any transaction (it used to be taken inside the
  // history lock's transaction, held across the whole copy); then one short
  // transaction under the lock writes the row naming it. A copy of a file a
  // restore replaced meanwhile is taken again (twice at most).
  let snap: AppSnapshot | null;
  for (let attempt = 1; ; attempt++) {
    try {
      snap = await stageThenFlipSnapshot(
        async () => {
          const staged = await stageAppSnapshot(ownerId, appId, o);
          if (!staged.data && o.requireData) throw new SnapshotNotRecorded('not_needed');
          return staged;
        },
        (staged) =>
          db.transaction((tx) =>
            inFlipTransaction(async () => {
              await lockAppHistory(tx, appId);
              if (
                opts.onlyIfNoneSince &&
                (await snapshotSince(tx, appId, trigger, opts.onlyIfNoneSince))
              ) {
                throw new SnapshotNotRecorded('not_needed');
              }
              // The last try takes the copy though writes landed since
              // (a consistent copy, a few writes older than the code read
              // now): a busy app still gets its snapshot.
              return recordAppSnapshot(tx, ownerId, appId, o, staged, attempt >= 3);
            }),
          ),
      );
      break;
    } catch (err) {
      if (err instanceof SnapshotNotRecorded) {
        if (err.why === 'moved' && attempt < 3) continue;
        if (err.why === 'not_needed') return null;
      }
      throw err;
    }
  }
  if (snap && trigger !== 'manual') await pruneAutoSnapshots(appId, trigger);
  return snap;
}

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
 *  live) stays: it is the app's history. False when it is not there. The
 *  row goes now; its trigger records the copy, which the store sweep
 *  removes a grace period later (A3b part 2). */
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
    .returning({ id: nodeSnapshots.id });
  return gone.length > 0;
}

/**
 * A member deletes one snapshot THEY took of their own app (access matrix
 * N6), as `deleteAppSnapshot` deletes one for the owner: the history row and
 * its database copy, never the app's own data (the live database file is
 * not touched) and never a version. Narrower than the owner's: only a manual
 * snapshot whose row names this member login. An automatic one (before a
 * schema change, a restore, an MCP write) is the app's safety net and never
 * counts against their budget, and another login's is not theirs. Under
 * the app's history lock, so no restore is reading the copy it removes; the
 * copy goes once the row's removal commits (`afterCommit`: inside a
 * caller's transaction, after that one). Null when the app has no such
 * entry.
 */
/** Of an app's history, the ids of the manual snapshots `memberLoginId`
 *  took: the ones deleteMemberAppSnapshot lets that member delete. */
export async function memberOwnSnapshotIds(
  ownerId: string,
  appId: string,
  memberLoginId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: nodeSnapshots.id })
    .from(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.ownerId, ownerId),
        eq(nodeSnapshots.nodeId, appId),
        eq(nodeSnapshots.trigger, 'manual'),
        eq(nodeSnapshots.actor, 'member'),
        eq(nodeSnapshots.actorLoginId, memberLoginId),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

export async function deleteMemberAppSnapshot(
  ownerId: string,
  appId: string,
  snapshotId: string,
  memberLoginId: string,
): Promise<{ id: string; seq: number; freedBytes: number } | null> {
  const gone = await db.transaction(async (tx) => {
    await lockAppHistory(tx, appId);
    const [row] = await tx
      .select({
        id: nodeSnapshots.id,
        seq: nodeSnapshots.seq,
        trigger: nodeSnapshots.trigger,
        actor: nodeSnapshots.actor,
        actorLoginId: nodeSnapshots.actorLoginId,
        dbPath: nodeSnapshots.dbPath,
        dbBytes: nodeSnapshots.dbBytes,
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
    if (row.trigger === 'publish') {
      throw new AppSnapshotRefusedError(
        `v${row.seq} is a version (what a publish made live) and stays in your app's history; only snapshots you took can be deleted`,
      );
    }
    if (row.trigger !== 'manual') {
      throw new AppSnapshotRefusedError(
        `v${row.seq} is an automatic snapshot (${row.trigger}), the app's own safety net: it stays, and it never counts against your snapshot budget. Only snapshots you took with my_app_snapshot_create can be deleted`,
      );
    }
    if (row.actor !== 'member' || row.actorLoginId !== memberLoginId) {
      throw new AppSnapshotRefusedError(
        `v${row.seq} is not a snapshot you took; only your own (my_app_snapshot_create) can be deleted`,
      );
    }
    await tx.delete(nodeSnapshots).where(eq(nodeSnapshots.id, snapshotId));
    return row;
  });
  // The copy is the store sweep's: the row's trigger recorded it (A3b part
  // 2), so a delete that rolls back (inside a caller's transaction) keeps it.
  if (!gone) return null;
  return { id: gone.id, seq: gone.seq, freedBytes: Number(gone.dbBytes ?? 0) };
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
 * The one door before an app's code is replaced (F4 fix round 3, M3): a
 * restore of its code (mode code or full) and an import over it. The code
 * is the app's home Moderators' (D4: APP_CODE_COLUMNS need manage), so the
 * caller's manage of the app is asked here, in its scope, BEFORE the undo
 * snapshot (`pre_restore`, `pre_import`) is taken: a caller that may only
 * edit the app writes nothing, on the route and on a tool or MCP alike (a
 * refusal after the snapshot had committed was a partial restore). Throws
 * the edit check's refusal (the 404 or the 403 item-workspace).
 */
export async function snapshotBeforeCodeChange(
  ownerId: string,
  appId: string,
  opts: Parameters<typeof createAppSnapshot>[2] & { trigger: 'pre_restore' | 'pre_import' },
): Promise<AppSnapshot | null> {
  await assertItemRight(appId, 'manage');
  return createAppSnapshot(ownerId, appId, opts);
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
    /** The member a 'member' row names (team apps Phase 3). */
    actorLoginId?: string | null;
    /** Tests only: the drain before the file swap. */
    drainMs?: number;
  },
): Promise<AppRestoreResult | null> {
  const { mode } = opts;
  const actor = opts.actor ?? 'owner';
  const wantsData = mode === 'data' || mode === 'full';
  const wantsCode = mode === 'code' || mode === 'full';
  // The code is the app's Moderators' (D4), the data alone the data's
  // (edit): asked first, before the entry is read or refused and before the
  // undo snapshot (snapshotBeforeCodeChange asks the code's again there),
  // so a caller without it learns nothing of the history and writes nothing
  // (pre-check removal Part 3).
  await assertItemRight(appId, wantsCode ? 'manage' : 'edit');
  const snap = await getAppSnapshot(ownerId, appId, snapshotId);
  if (!snap) return null;
  if (wantsData && !snap.hasData) {
    throw new AppSnapshotRefusedError(
      `v${snap.seq} holds no data (it is ${snap.kind === 'version' ? 'a version: the code a publish made live' : 'a snapshot of an app that had no database yet'}); restore its code, or pick a snapshot with data`,
      'no-data',
    );
  }
  if (wantsCode && !snap.code) {
    throw new AppSnapshotRefusedError(`v${snap.seq} holds no code to restore`, 'no-data');
  }

  // Refuse before the undo snapshot: nothing changes (checked again under
  // the lock below).
  if (wantsCode && !opts.discardDraft) {
    const now = await currentCode(ownerId, appId);
    if (now?.draft) throw new AppRestoreDraftError();
  }
  // The undo snapshot in its OWN committed step, before anything changes
  // (team apps follow-up): if the restore below fails after its file swap,
  // the way back is still a row on the history, never a lost file.
  // createAppSnapshot takes the history lock, removes its copy if its row
  // does not commit, and prunes the automatic snapshots. A lost live file is
  // what a data restore is for: the undo keeps the code then (apps audit
  // 2026-10-02, item 4).
  const undo = await (wantsCode ? snapshotBeforeCodeChange : createAppSnapshot)(ownerId, appId, {
    trigger: 'pre_restore',
    actor,
    actorLoginId: opts.actorLoginId ?? null,
    note: `before restoring v${snap.seq} (${mode})`,
    codeOnlyWhenLost: true,
  });
  const result = await db.transaction(async (tx) => {
    await lockAppHistory(tx, appId);
    // Still this owner's app: an Accept moves a member's app to the brain
    // under the same lock, and a restore must not land on it after that.
    const [still] = await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.id, appId), eq(nodes.ownerId, ownerId)))
      .limit(1);
    if (!still) {
      throw new AppSnapshotRefusedError(
        'this app moved (it was accepted into the brain), so nothing was restored',
        'no-data',
      );
    }
    if (wantsCode && !opts.discardDraft) {
      const now = await currentCode(ownerId, appId);
      if (now?.draft) throw new AppRestoreDraftError();
    }
    if (wantsData) {
      const file = await appSnapshotFile(ownerId, appId, snapshotId);
      if (!file) throw new AppSnapshotRefusedError(`v${snap.seq} holds no data`, 'no-data');
      await restoreAppDatabaseFile(ownerId, appId, file.path, snap.schemaVersion ?? 0, {
        ...(opts.drainMs !== undefined ? { drainMs: opts.drainMs } : {}),
      });
    }
    let code: AppRestoreResult['code'] = null;
    let declaredTools: string[] | null = null;
    // The author ceiling FIRST (team apps Phase 3; M3 re-audit, low 2):
    // code a member wrote, or code taken while the app ran at team rules,
    // brings the ceiling back before it can go live, so not one call runs it
    // at admin rules, and a restore that fails after this leaves it at team
    // (fail safe). On `db`, which is what the code restore below writes
    // through. Only an admin's own "trust its tools" lifts it again.
    if (wantsCode && (snap.actor === 'member' || snap.code?.meta?.authorLevel === 'team')) {
      await db
        .update(apps)
        .set({ authorLevel: 'team', updatedAt: new Date() })
        .where(eq(apps.nodeId, appId));
    }
    if (wantsCode && snap.code) {
      const build = snap.code.publishedBuild;
      if (mode === 'full' && build?.ok) {
        await restoreAppLive(ownerId, appId, { ...snap.code, publishedBuild: build }, snap.seq, {
          discardDraft: true,
          actor,
          actorLoginId: opts.actorLoginId ?? null,
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
  const { code: _code, schemaVersion: _sv, ...restored } = result.restored;
  return { ...result, restored };
}
