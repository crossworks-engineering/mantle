/**
 * File history (docs/files.md, "File history"; owner's decisions
 * 2026-11-18). A file joins the numbered history line apps and tables have
 * (node_snapshots, node_kind 'file', migration 0384):
 *
 *  - new bytes over a file (upsertFile with overwrite) keep the bytes they
 *    replace as a `replace` version: the overwrite's own hard link of the
 *    old bytes (disk.ts overwritePlacement) lands in the history folder
 *    instead of a temporary name, and its row is written in the overwrite's
 *    own transaction, after the link (recordFileVersion). Same bytes keep
 *    nothing.
 *  - a restore (file-history-restore.ts) puts a version's bytes back through
 *    the same overwrite, which keeps the bytes it replaces as `pre_restore`:
 *    a restore is undone the same way.
 *  - the newest FILE_HISTORY_KEEP versions stay per file, and the whole box
 *    keeps FILE_HISTORY_MAX_MB of them, oldest pruned first, the newest
 *    always (pruneFileHistory, after each overwrite). Pruned files go at
 *    once, so a loop of overwrites never holds more than the cap.
 *  - a deleted file's history goes FILE_HISTORY_ORPHAN_DAYS after its newest
 *    version, in the nightly purge (purgeOrphanFileHistory). No new job.
 *
 * Paths: MANTLE_FILES_ROOT/.file-history/<owner>/<file>/<version>.bin, every
 * part a uuid the server made (no name a user gives is ever in it), under
 * the files root so the keep is a link, not a copy. A dot folder: the
 * watcher, the untracked scan and the staged-leftover sweep never enter it.
 * A version's row is read where its file is read (0265) and written with
 * edit of its file (the access matrix); restore and delete of a version are
 * the Moderators' (assertMayModerateFile).
 *
 * Server-only (node:fs).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { envNum } from '@mantle/config';
import { db, mayModerateSql, nodeSnapshots, systemStep, type NodeSnapshot } from '@mantle/db';
import { currentSpaceScope, currentWorkspaceScope } from '@mantle/db/viewer';
import { editCheckRefusalError, errorMessage, UUID_RE } from '@mantle/std';
import { filesRoot } from './paths';

/** Why a version was kept (FileVersionTrigger, @mantle/client-types). */
export type FileVersionTrigger = 'replace' | 'pre_restore';

/** One kept version of a file: the shape of FileVersion
 *  (@mantle/client-types dto/file-history.ts), which the routes answer. */
export type FileVersion = {
  id: string;
  seq: number;
  trigger: FileVersionTrigger;
  createdAt: string;
  sizeBytes: number;
  sha256: string | null;
  filename: string | null;
  actor: string;
  restoredFrom: number | null;
};

/** Who a version's row names (HISTORY_ACTORS, @mantle/client-types). */
type HistoryActor = NodeSnapshot['actor'];

/** The history folder's name under the files root. */
export const FILE_HISTORY_DIR = '.file-history';

/** A deleted file's history goes this long after its newest version. */
export const FILE_HISTORY_ORPHAN_DAYS = 30;

/** The kinds of row a file's history holds. */
const FILE_TRIGGERS: readonly FileVersionTrigger[] = ['replace', 'pre_restore'];

/** Where the versions live. */
export function fileHistoryRoot(): string {
  return path.join(filesRoot(), FILE_HISTORY_DIR);
}

/** A version's path relative to the history root: uuids only. */
export function fileVersionRelPath(ownerId: string, fileId: string, versionId: string): string {
  for (const id of [ownerId, fileId, versionId]) {
    if (!UUID_RE.test(id)) throw new Error(`file history: not a uuid: ${String(id).slice(0, 40)}`);
  }
  return `${ownerId}/${fileId}/${versionId}.bin`;
}

/** A row's file, absolute; throws for a path outside the history root (a
 *  row is the database's, but the disk is never read past the root). */
export function fileVersionAbsPath(rel: string): string {
  const root = path.resolve(fileHistoryRoot());
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) {
    throw new Error('file history: a version path outside the history folder');
  }
  return abs;
}

/**
 * Whether new bytes over a file keep the old ones: not in a personal space's
 * scope (no grant on node_snapshots there: a refused insert would fail the
 * write it rides; as table history's historyKept), and only for a file in
 * the files tree (a folded member file's old bytes are not in the tree).
 */
export function fileHistoryKept(parentPath: string): boolean {
  if (currentSpaceScope() !== null) return false;
  return parentPath === 'files' || parentPath.startsWith('files.');
}

/** Who the current work is, for a version's row. */
function actorNow(ownerId: string): { actor: HistoryActor; actorLoginId: string | null } {
  const scope = currentWorkspaceScope();
  if (!scope) return { actor: 'system', actorLoginId: null };
  if (scope.kind === 'assistant') return { actor: 'agent', actorLoginId: scope.loginId };
  if (!scope.loginId) return { actor: 'system', actorLoginId: null };
  return {
    actor: scope.loginId === ownerId ? 'owner' : 'member',
    actorLoginId: scope.loginId,
  };
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A version's row, inside the overwrite's own transaction, once its bytes are
 * kept (after the link). The overwrite holds the file row's heads
 * (withHeads), and every version of a file is written here, so the next seq
 * is read under that lock; the (node, seq) index is the backstop.
 */
export async function recordFileVersion(
  tx: Pick<DbTx, 'select' | 'insert'>,
  v: {
    id: string;
    ownerId: string;
    fileId: string;
    rel: string;
    sizeBytes: number;
    sha256: string | null;
    filename: string | null;
    trigger: FileVersionTrigger;
    restoredFrom?: number | null;
  },
): Promise<void> {
  const [top] = await tx
    .select({ next: sql<number>`coalesce(max(${nodeSnapshots.seq}), 0) + 1` })
    .from(nodeSnapshots)
    .where(eq(nodeSnapshots.nodeId, v.fileId));
  await tx.insert(nodeSnapshots).values({
    id: v.id,
    ownerId: v.ownerId,
    nodeId: v.fileId,
    nodeKind: 'file',
    seq: Number(top?.next ?? 1),
    trigger: v.trigger,
    note: v.filename ? v.filename.slice(0, 500) : null,
    ...actorNow(v.ownerId),
    code: null,
    sourceHash: v.sha256,
    dbPath: v.rel,
    dbBytes: v.sizeBytes,
    restoredFrom: v.restoredFrom ?? null,
  });
}

const versionCols = () => ({
  id: nodeSnapshots.id,
  seq: nodeSnapshots.seq,
  trigger: nodeSnapshots.trigger,
  note: nodeSnapshots.note,
  actor: nodeSnapshots.actor,
  createdAt: nodeSnapshots.createdAt,
  dbBytes: nodeSnapshots.dbBytes,
  dbPath: nodeSnapshots.dbPath,
  sourceHash: nodeSnapshots.sourceHash,
  restoredFrom: nodeSnapshots.restoredFrom,
});

type VersionRow = Pick<
  NodeSnapshot,
  | 'id'
  | 'seq'
  | 'trigger'
  | 'note'
  | 'actor'
  | 'createdAt'
  | 'dbBytes'
  | 'dbPath'
  | 'sourceHash'
  | 'restoredFrom'
>;

function toVersion(r: VersionRow): FileVersion {
  return {
    id: r.id,
    seq: r.seq,
    trigger: r.trigger as FileVersionTrigger,
    createdAt: r.createdAt.toISOString(),
    sizeBytes: Number(r.dbBytes ?? 0),
    sha256: r.sourceHash,
    filename: r.note,
    actor: r.actor,
    restoredFrom: r.restoredFrom,
  };
}

/** A file's versions, newest first, as the caller's scope reads them (a
 *  version is read where its file is: 0265). The caller read the file
 *  first (the 404 of a file it does not read). */
export async function listFileVersions(ownerId: string, fileId: string): Promise<FileVersion[]> {
  const rows = await db
    .select(versionCols())
    .from(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.nodeId, fileId),
        eq(nodeSnapshots.ownerId, ownerId),
        eq(nodeSnapshots.nodeKind, 'file'),
      ),
    )
    .orderBy(desc(nodeSnapshots.seq))
    .limit(200);
  return rows.map(toVersion);
}

/** One version of a file with its bytes' place, or null (no such version
 *  of this file, or one the scope does not read). */
export async function fileVersion(
  ownerId: string,
  fileId: string,
  versionId: string,
): Promise<(FileVersion & { abs: string | null }) | null> {
  if (!UUID_RE.test(versionId)) return null;
  const [row] = await db
    .select(versionCols())
    .from(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.id, versionId),
        eq(nodeSnapshots.nodeId, fileId),
        eq(nodeSnapshots.ownerId, ownerId),
        eq(nodeSnapshots.nodeKind, 'file'),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { ...toVersion(row), abs: row.dbPath ? fileVersionAbsPath(row.dbPath) : null };
}

/** How many versions each file has, in one read (the caller's scope: only
 *  files it reads count). Files with none are absent. */
export async function fileVersionCounts(ids: readonly string[]): Promise<Map<string, number>> {
  const list = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (list.length === 0) return new Map();
  const rows = await db
    .select({ id: nodeSnapshots.nodeId, n: sql<number>`count(*)::int` })
    .from(nodeSnapshots)
    .where(and(inArray(nodeSnapshots.nodeId, list), eq(nodeSnapshots.nodeKind, 'file')))
    .groupBy(nodeSnapshots.nodeId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

/** Rows with `versions`: the count of each one's kept versions (0 for
 *  none), one read for the whole list. */
export async function withVersions<T extends { id: string }>(
  rows: T[],
): Promise<(T & { versions: number })[]> {
  if (rows.length === 0) return [];
  const counts = await fileVersionCounts(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, versions: counts.get(r.id) ?? 0 }));
}

/** The refusal of a restore or a version's delete by a caller who reads the
 *  file but does not moderate it. */
export const FILE_VERSION_RIGHT_MESSAGE =
  'Restoring or deleting a version of a file is for a Moderator of its workspace, a Moderator of a workspace that holds it, or an Admin.';

/** Whether the current scope may restore a version of the file and delete
 *  one (mayModerateSql: manage, or a Moderator of a workspace that holds
 *  it). Null: the scope does not read the file. System work: yes. */
export async function mayModerateFile(fileId: string): Promise<boolean | null> {
  if (!currentWorkspaceScope()) return true;
  if (!UUID_RE.test(fileId)) return null;
  const rows = (await db.execute(sql`
    select ${mayModerateSql('n')} as ok
      from nodes n where n.id = ${fileId}::uuid and n.type = 'file'`)) as unknown as {
    ok: boolean | null;
  }[];
  const row = rows[0];
  if (!row) return null;
  return row.ok === true;
}

/** Throws the edit check's refusal unless the current scope may moderate
 *  the file: 404 for one it does not read, 403 for one it reads only. */
export async function assertMayModerateFile(fileId: string): Promise<void> {
  const ok = await mayModerateFile(fileId);
  if (ok === null) throw editCheckRefusalError('no_read');
  if (!ok) {
    throw Object.assign(editCheckRefusalError('no_edit'), { message: FILE_VERSION_RIGHT_MESSAGE });
  }
}

/**
 * Delete one version of a file (a Moderator's act). False when there is no
 * such version of a file the scope reads. The row goes now; its trigger
 * records its file, which the store sweep removes a grace period later
 * (store_tombstones, 0284).
 */
export async function deleteFileVersion(
  ownerId: string,
  fileId: string,
  versionId: string,
): Promise<boolean> {
  await assertMayModerateFile(fileId);
  if (!UUID_RE.test(versionId)) return false;
  const gone = await db
    .delete(nodeSnapshots)
    .where(
      and(
        eq(nodeSnapshots.id, versionId),
        eq(nodeSnapshots.nodeId, fileId),
        eq(nodeSnapshots.ownerId, ownerId),
        eq(nodeSnapshots.nodeKind, 'file'),
      ),
    )
    .returning({ id: nodeSnapshots.id });
  return gone.length > 0;
}

/** Remove the files of pruned rows now (their tombstones then name files
 *  already gone, which the store sweep forgets). */
async function removeVersionFiles(paths: readonly (string | null)[]): Promise<void> {
  for (const rel of paths) {
    if (!rel) continue;
    try {
      await fs.unlink(fileVersionAbsPath(rel));
    } catch {
      // gone already, or a path outside the root: never followed
    }
  }
}

/**
 * Prune after new bytes replaced `fileId`: its versions past the newest
 * FILE_HISTORY_KEEP, then every file's versions past FILE_HISTORY_MAX_MB
 * for the whole box, oldest first (the newest version of the box always
 * stays, whatever its size). Each one statement, so a version written
 * meanwhile is never removed. The named system step (the brain's
 * bookkeeping: the box cap removes versions of files the caller does not
 * read). Never fails the write it follows: a failure is logged, and the
 * next write prunes again.
 */
export async function pruneFileHistory(fileId: string): Promise<void> {
  try {
    await systemStep('file-history', { items: [fileId], need: 'edit' }, async () => {
      const keep = envNum('FILE_HISTORY_KEEP');
      const maxBytes = envNum('FILE_HISTORY_MAX_MB') * 1024 * 1024;
      const perFile = await db
        .delete(nodeSnapshots)
        .where(
          sql`${nodeSnapshots.id} in (
            select id from (
              select id, row_number() over (order by seq desc) as rn
                from node_snapshots
               where node_id = ${fileId} and node_kind = 'file'
            ) ranked
            where rn > ${keep})`,
        )
        .returning({ dbPath: nodeSnapshots.dbPath });
      const boxWide = await db
        .delete(nodeSnapshots)
        .where(
          sql`${nodeSnapshots.id} in (
            select id from (
              select id,
                     row_number() over w as rn,
                     sum(coalesce(db_bytes, 0)) over w as cum
                from node_snapshots
               where node_kind = 'file'
              window w as (order by created_at desc, id desc
                           rows between unbounded preceding and current row)
            ) ranked
            where rn > 1 and cum > ${maxBytes})`,
        )
        .returning({ dbPath: nodeSnapshots.dbPath });
      await removeVersionFiles([...perFile, ...boxWide].map((r) => r.dbPath));
    });
  } catch (err) {
    console.error(
      '[files] file history prune failed (the next write prunes again):',
      errorMessage(err),
    );
  }
}

/**
 * The history of files that are gone, FILE_HISTORY_ORPHAN_DAYS after its
 * newest version: rows and files. Part of the nightly `app-trash-purge`
 * sweep (as purgeOrphanTableHistory). Plain SQL and file removal, no model.
 */
export async function purgeOrphanFileHistory(
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<{ files: number }> {
  const cutoff = new Date(
    (opts.now ?? new Date()).getTime() - FILE_HISTORY_ORPHAN_DAYS * 86_400_000,
  );
  const rows = (await db.execute(sql`
    select s.owner_id, s.node_id
      from node_snapshots s
     where s.node_kind = 'file'
       and not exists (select 1 from nodes n where n.id = s.node_id)
     group by s.owner_id, s.node_id
    having max(s.created_at) < ${cutoff.toISOString()}::timestamptz`)) as unknown as {
    owner_id: string;
    node_id: string;
  }[];
  if (opts.dryRun) return { files: rows.length };
  for (const r of rows) {
    const gone = await db
      .delete(nodeSnapshots)
      .where(
        and(
          eq(nodeSnapshots.ownerId, r.owner_id),
          eq(nodeSnapshots.nodeId, r.node_id),
          eq(nodeSnapshots.nodeKind, 'file'),
        ),
      )
      .returning({ dbPath: nodeSnapshots.dbPath });
    await removeVersionFiles(gone.map((g) => g.dbPath));
  }
  return { files: rows.length };
}

/** The node kinds' triggers a file's history holds (for tests and the
 *  sweep's spec). */
export const FILE_VERSION_TRIGGERS = FILE_TRIGGERS;
