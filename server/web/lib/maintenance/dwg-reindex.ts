/**
 * Rebuild the auto-import workbook of DWG/DXF files IN PLACE, so a drawing
 * imported before the bones tabs (Segments, Nodes, Inserts, Circuits) gains
 * them without losing its table. The SAME table node keeps its id, so
 * links, grants, workspace placement, title and tags all survive; only its
 * workbook tabs and its description are rebuilt, from a fresh sidecar pass
 * over the file's bytes (the same builder as the first import,
 * @mantle/files/dwg `cadRegistryWorkbook`).
 *
 * Manual only: the `dwg-reindex` maintenance task (scripts/dwg-reindex.ts),
 * scoped by file id or folder, a per-run cap, dry run by default. No cron,
 * no trigger, nothing that runs on its own.
 *
 * Spend: the commit keeps the table's summary and entities (keepSummary:
 * the re-index is `cells`, the vector and the profile passages again, no
 * model pass). `--resummarize` lets the commit run the extractor's full
 * pass (one model call per table) for a table whose summary should change.
 *
 * Never deletes a file or a table. A table someone edited after its import
 * (its version moved past the import's, or past the last re-index) is
 * refused, unless `--keep-edits`: then a named snapshot of the edited
 * version is taken first (restorable from the table's history), and the
 * rebuild replaces the tabs. A table with an unsaved draft is always
 * refused: the rebuild would replace someone's working copy.
 *
 * Output is counts and ids only: safe on a client box.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, nodes, tables, withHeads } from '@mantle/db';
import { commitTable, saveTableDraft, tableDocFromGrid } from '@mantle/content';
import { createTableSnapshot } from '@mantle/content/table-snapshots';
import { cadRegistryWorkbook } from '@mantle/files/dwg';
import { readFileById } from '@mantle/files';
import { envNum } from '@mantle/config';
import { errorMessage } from '@mantle/std';

/** Default and hard cap of tables per run. */
export const REINDEX_DEFAULT_LIMIT = 10;
export const REINDEX_MAX_LIMIT = 50;
/** Node data key: the table version the last re-index committed. */
export const REINDEXED_VERSION_KEY = 'dwgReindexedVersion';

export type ReindexScope = { fileIds?: string[]; folderId?: string };

export type ReindexCandidate = {
  tableId: string;
  ownerId: string;
  fileId: string;
  filename: string;
  version: number;
  reindexedVersion: number | null;
  hasDraft: boolean;
  tabs: string[];
};

export type ReindexDecision =
  { action: 'rebuild'; snapshotFirst: boolean } | { action: 'refuse'; reason: 'draft' | 'edited' };

/** Clamp the asked limit to [1, REINDEX_MAX_LIMIT]. */
export function clampLimit(asked: number | null | undefined): number {
  if (asked === null || asked === undefined || !Number.isFinite(asked))
    return REINDEX_DEFAULT_LIMIT;
  return Math.max(1, Math.min(REINDEX_MAX_LIMIT, Math.floor(asked)));
}

/** A scope is required: a file id list or a folder, never the whole brain
 *  by default. */
export function scopeProblem(scope: ReindexScope): string | null {
  const files = (scope.fileIds ?? []).filter(Boolean);
  if (!files.length && !scope.folderId) {
    return 'name what to rebuild: --file=<file id>[,<file id>] or --folder=<folder id>';
  }
  const bad = [...files, ...(scope.folderId ? [scope.folderId] : [])].find(
    (id) => !/^[0-9a-f-]{36}$/i.test(id),
  );
  return bad ? `not an id: ${bad}` : null;
}

/** Edited since its import (or its last re-index): its version moved on. */
export function wasEdited(c: Pick<ReindexCandidate, 'version' | 'reindexedVersion'>): boolean {
  return c.version > (c.reindexedVersion ?? 1);
}

export function decide(
  c: Pick<ReindexCandidate, 'version' | 'reindexedVersion' | 'hasDraft'>,
  opts: { keepEdits?: boolean },
): ReindexDecision {
  if (c.hasDraft) return { action: 'refuse', reason: 'draft' };
  if (wasEdited(c)) {
    return opts.keepEdits
      ? { action: 'rebuild', snapshotFirst: true }
      : { action: 'refuse', reason: 'edited' };
  }
  return { action: 'rebuild', snapshotFirst: false };
}

/**
 * The auto-import tables of DWG/DXF files in scope, oldest first, one more
 * than `limit` so the caller can say the run was cut. Brain spaces only;
 * a table the import did not make (no `auto-import` tag, no source file)
 * is never a candidate.
 */
export async function findReindexCandidates(
  scope: ReindexScope,
  limit: number,
): Promise<ReindexCandidate[]> {
  const f = alias(nodes, 'f');
  const conds = [
    sql`public.mantle_is_brain_space(${nodes.ownerId})`,
    eq(nodes.type, 'table'),
    sql`'auto-import' = ANY(${nodes.tags})`,
    eq(f.type, 'file'),
    sql`lower(coalesce(${f.data}->>'filename', ${f.title})) ~ '\\.(dwg|dxf)$'`,
  ];
  const files = (scope.fileIds ?? []).filter(Boolean);
  if (files.length) conds.push(inArray(f.id, files));
  if (scope.folderId) {
    conds.push(
      sql`${f.path} <@ (select p.path from ${nodes} p where p.id = ${scope.folderId} and p.type = 'branch')`,
    );
  }
  const rows = await db
    .select({
      tableId: nodes.id,
      ownerId: nodes.ownerId,
      data: nodes.data,
      fileId: f.id,
      fileTitle: f.title,
      fileData: f.data,
      version: tables.version,
      hasDraft: sql<boolean>`(${tables.draftPath} is not null or ${tables.draftData} is not null)`,
      stats: tables.stats,
    })
    .from(nodes)
    .innerJoin(tables, eq(tables.nodeId, nodes.id))
    .innerJoin(f, sql`${f.id}::text = ${nodes.data}->>'sourceFileId'`)
    .where(and(...conds))
    .orderBy(asc(nodes.createdAt))
    .limit(limit + 1);
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const fd = (r.fileData ?? {}) as Record<string, unknown>;
    const stats = (r.stats ?? {}) as { tabs?: { name?: string }[] };
    const rv = Number(d[REINDEXED_VERSION_KEY]);
    return {
      tableId: r.tableId,
      ownerId: r.ownerId,
      fileId: r.fileId,
      filename: typeof fd.filename === 'string' ? fd.filename : r.fileTitle,
      version: Number(r.version),
      reindexedVersion: Number.isFinite(rv) && rv > 0 ? rv : null,
      hasDraft: r.hasDraft === true,
      tabs: (stats.tabs ?? []).map((t) => String(t.name ?? '')).filter(Boolean),
    };
  });
}

/** The tabs a file's bytes build, as the auto-import pass builds them
 *  (server/api extract/auto-table.ts): one tab per non-empty grid, capped. */
export async function buildTabs(bytes: Buffer, filename: string) {
  const ext = filename.toLowerCase().endsWith('.dxf') ? 'dxf' : 'dwg';
  const { grids, description } = await cadRegistryWorkbook(bytes, ext);
  const tabs = grids.sheets
    .slice(0, envNum('MANTLE_MAX_AUTO_TABLE_TABLES'))
    .map((sheet, i) => ({
      ...tableDocFromGrid(sheet),
      name: (sheet.name || `Sheet${i + 1}`).slice(0, 100),
    }))
    .filter((t) => t.columns.length > 0 && t.rows.length > 0);
  return { tabs, description };
}

export type ReindexOutcome =
  | { tableId: string; result: 'rebuilt'; tabs: string[]; snapshot: string | null; version: number }
  | { tableId: string; result: 'refused'; reason: string }
  | { tableId: string; result: 'failed'; reason: string };

/** Rebuild one candidate. Never throws: the outcome says what happened. */
export async function rebuildOne(
  c: ReindexCandidate,
  opts: { keepEdits?: boolean; resummarize?: boolean },
): Promise<ReindexOutcome> {
  const d = decide(c, opts);
  if (d.action === 'refuse') {
    return {
      tableId: c.tableId,
      result: 'refused',
      reason:
        d.reason === 'draft'
          ? 'the table has an unsaved draft: commit or discard it first'
          : 'the table was edited after its import: pass --keep-edits to snapshot that version first and rebuild',
    };
  }
  try {
    const file = await readFileById({ ownerId: c.ownerId, fileId: c.fileId });
    if (!file)
      return { tableId: c.tableId, result: 'failed', reason: 'the file bytes are missing' };
    const { tabs, description } = await buildTabs(file.bytes, c.filename);
    if (tabs.length === 0) {
      return {
        tableId: c.tableId,
        result: 'failed',
        reason: 'the sidecar pass gave no tabs (not a readable drawing); the table is unchanged',
      };
    }
    let snapshot: string | null = null;
    if (d.snapshotFirst) {
      const snap = await createTableSnapshot(c.ownerId, c.tableId, {
        note: 'before dwg-reindex (the edited version)',
      });
      if (!snap)
        return {
          tableId: c.tableId,
          result: 'failed',
          reason: 'the snapshot was refused; nothing rebuilt',
        };
      snapshot = snap.id;
    }
    const saved = await saveTableDraft(c.ownerId, c.tableId, { tabs }, { replace: true });
    if (!saved || !saved.ok) {
      return {
        tableId: c.tableId,
        result: 'failed',
        reason: 'the draft could not be written; nothing committed',
      };
    }
    const committed = await commitTable(c.ownerId, c.tableId, undefined, {
      keepSummary: !opts.resummarize,
      note: 'dwg-reindex',
    });
    if (!committed)
      return { tableId: c.tableId, result: 'failed', reason: 'the commit found no table' };
    const [v] = await db
      .select({ version: tables.version })
      .from(tables)
      .where(eq(tables.nodeId, c.tableId))
      .limit(1);
    const version = Number(v?.version ?? c.version + 1);
    await withHeads([c.tableId], 'update', (tx) =>
      tx
        .update(nodes)
        .set({
          data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${JSON.stringify({
            ...(description ? { description } : {}),
            [REINDEXED_VERSION_KEY]: version,
            dwgReindexedAt: new Date().toISOString(),
          })}::jsonb`,
        })
        .where(and(eq(nodes.id, c.tableId), eq(nodes.type, 'table'))),
    );
    return {
      tableId: c.tableId,
      result: 'rebuilt',
      tabs: tabs.map((t) => t.name),
      snapshot,
      version,
    };
  } catch (err) {
    return { tableId: c.tableId, result: 'failed', reason: errorMessage(err).slice(0, 300) };
  }
}
