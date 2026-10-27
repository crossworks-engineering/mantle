/**
 * Rebuild the auto-import workbook of DWG/DXF files IN PLACE, so a drawing
 * imported before the bones tabs (Segments, Nodes, Inserts, Circuits) gains
 * them without losing its table. The SAME table node keeps its id, so
 * links, grants, workspace placement, title and tags all survive; only its
 * workbook tabs and its description are rebuilt, from a fresh CAD pass
 * over the file's bytes (the same builder as the first import,
 * @mantle/files/dwg `cadRegistryWorkbook`).
 *
 * Manual only: the `dwg-reindex` maintenance task (scripts/dwg-reindex.ts),
 * scoped by file id or folder, a per-run cap, dry run by default. No cron,
 * no trigger, nothing that runs on its own.
 *
 * Spend: the commit keeps the table's summary and entities (keepSummary:
 * the re-index is `cells`, the vector and the profile passages again, no
 * model pass), except where the old description said the table holds no
 * vector geometry: its summary was written from that claim, which the
 * rebuild makes false, so that commit runs the extractor's full pass (one
 * model call per such table, at most the run's cap). `--resummarize` runs
 * the full pass for every table.
 *
 * Progress: a table this task already rebuilt, or one imported with the
 * bones tabs, is not a candidate again unless `again` (`--again`), so
 * repeated capped runs reach the rest of the scope.
 *
 * Never deletes a file or a table. A table someone edited after its import
 * (its version moved past the import's, or past the last re-index) is
 * refused, unless `--keep-edits`: then a named snapshot of the edited
 * version is taken first (restorable from the table's history), and the
 * rebuild replaces the tabs. A table with an unsaved draft is always
 * refused: the rebuild would replace someone's working copy. The draft
 * state and the version are read again right before the write (a user may
 * open a draft or commit while the CAD pass runs), and the draft is
 * saved against the draft revision that read saw, so a draft made in that
 * gap is never overwritten. A commit that fails after the draft is saved
 * discards that draft: no half-done replacement is left to commit by
 * accident.
 *
 * The image check's Checks tab (circuit_verify) is kept: its rows are read
 * before the rebuild and written back as the same tab, so the answers, tied
 * to the drawing's revision, survive. The table's `sourceSha256` is stamped
 * with the bytes the rebuild read: a file replaced in place is the new
 * revision from then on (its old answers stay in the tab, not applied). A check commit (circuit_verify writes
 * the tab, `dwgCheckedVersion`) on an unedited table is not an edit.
 *
 * Output is counts and ids only: safe on a client box.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, nodes, tables, withHeads } from '@mantle/db';
import { commitTable, discardTableDraft, saveTableDraft, tableDocFromGrid } from '@mantle/content';
import { createTableSnapshot } from '@mantle/content/table-snapshots';
import {
  cadRegistryWorkbook,
  DWG_CHECKED_VERSION_KEY as CHECKED_VERSION_KEY,
  DWG_CHECKS_TAB as CHECKS_TAB,
  DWG_REINDEXED_VERSION_KEY,
  DWG_SOURCE_SHA_KEY,
  dwgSourceSha,
  dwgTableEdited,
} from '@mantle/files/dwg';
import { tableSqlSurface } from '@mantle/content/table-storage';
import { readDocFile, TableTooLargeError } from '@mantle/tabledb';
import { readFileById } from '@mantle/files';
import { envNum } from '@mantle/config';
import { errorMessage } from '@mantle/std';

/** Default and hard cap of tables per run. */
export const REINDEX_DEFAULT_LIMIT = 10;
export const REINDEX_MAX_LIMIT = 50;
/** Node data key: the table version the last re-index committed. */
export const REINDEXED_VERSION_KEY = DWG_REINDEXED_VERSION_KEY;

export type ReindexScope = { fileIds?: string[]; folderId?: string };

export type ReindexCandidate = {
  tableId: string;
  ownerId: string;
  fileId: string;
  filename: string;
  version: number;
  reindexedVersion: number | null;
  /** The version the image check's last commit made on an unedited table. */
  checkedVersion?: number | null;
  hasDraft: boolean;
  tabs: string[];
  /** The table description as the candidate read found it. */
  description: string | null;
};

/** The sentence a pre-bones DWG description ends with (the old import and
 *  a failed geometry pass both write it). */
const NO_GEOMETRY_CLAIM = /Vector geometry\b[^.]*\bnot in this table/i;

/** Whether this rebuild's commit runs the extractor's full pass: always
 *  with `resummarize`, else only when the old description said there is no
 *  vector geometry and the new one does not (the old summary repeats a
 *  claim the rebuild makes false). */
export function needsResummary(
  oldDescription: string | null,
  newDescription: string | null,
  opts: { resummarize?: boolean },
): boolean {
  if (opts.resummarize) return true;
  return (
    NO_GEOMETRY_CLAIM.test(oldDescription ?? '') && !NO_GEOMETRY_CLAIM.test(newDescription ?? '')
  );
}

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

/** Edited since its import, its last re-index or its last image-check
 *  commit (which is not an edit): its version moved on. */
export function wasEdited(
  c: Pick<ReindexCandidate, 'version' | 'reindexedVersion' | 'checkedVersion'>,
): boolean {
  return dwgTableEdited(c);
}

export function decide(
  c: Pick<ReindexCandidate, 'version' | 'reindexedVersion' | 'checkedVersion' | 'hasDraft'>,
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
  opts: { again?: boolean } = {},
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
  if (!opts.again) {
    // Already rebuilt by this task, or imported with the bones tabs: done.
    conds.push(sql`not coalesce(${nodes.data} ? ${REINDEXED_VERSION_KEY}, false)`);
    conds.push(sql`not coalesce(${tables.stats}->'tabs' @> '[{"name":"Segments"}]'::jsonb, false)`);
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
    const cv = Number(d[CHECKED_VERSION_KEY]);
    return {
      tableId: r.tableId,
      ownerId: r.ownerId,
      fileId: r.fileId,
      filename: typeof fd.filename === 'string' ? fd.filename : r.fileTitle,
      version: Number(r.version),
      reindexedVersion: Number.isFinite(rv) && rv > 0 ? rv : null,
      checkedVersion: Number.isFinite(cv) && cv > 0 ? cv : null,
      hasDraft: r.hasDraft === true,
      tabs: (stats.tabs ?? []).map((t) => String(t.name ?? '')).filter(Boolean),
      description: typeof d.description === 'string' ? d.description : null,
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

/** The most rows a rebuild carries over in the Checks tab: a tab past it
 *  is refused whole (ChecksTabTooLarge), never cut. */
export const CHECKS_MAX = 100_000;

/** A Checks tab with more rows than a rebuild carries over. */
export class ChecksTabTooLarge extends Error {
  constructor(readonly rows: number) {
    super(`its Checks tab holds more than ${CHECKS_MAX.toLocaleString('en-US')} rows`);
    this.name = 'ChecksTabTooLarge';
  }
}

/** The table's Checks tab (circuit_verify's answers) as a tab to write
 *  back, or null when it has none. Read through the store's own reader
 *  (readDocFile): every column with its whole definition (type, options,
 *  format, formula, width), every row in its order with its id, each cell
 *  decoded as the store keeps it (a multiselect is its list, never its
 *  JSON text split on commas), and the tab's views and footer totals. So
 *  nothing is coerced a second time, and rebuilding a rebuilt table gives
 *  the same tab. One type does not carry: a reference column names a tab
 *  the rebuild replaces, so it comes back as text holding the value it
 *  showed. Throws ChecksTabTooLarge past CHECKS_MAX rows rather than lose
 *  any. */
export async function checksTabOf(ownerId: string, tableId: string) {
  const surface = await tableSqlSurface(ownerId, tableId);
  const tab = surface?.tabs.find((t) => t.name === CHECKS_TAB);
  if (!surface || !tab) return null;
  if (tab.rowCount > CHECKS_MAX) throw new ChecksTabTooLarge(tab.rowCount);
  let doc: ReturnType<typeof readDocFile>;
  try {
    // The reader counts again: rows added since the count above are judged too.
    doc = readDocFile(surface.abs, { tabId: tab.tabId, maxRows: CHECKS_MAX });
  } catch (err) {
    if (err instanceof TableTooLargeError) throw new ChecksTabTooLarge(err.rowCount);
    throw err;
  }
  return {
    ...doc,
    columns: doc.columns.map((col) => {
      if (col.type !== 'reference') return col;
      const { ref: _ref, ...rest } = col;
      return { ...rest, type: 'text' as const };
    }),
    name: CHECKS_TAB,
  };
}

/** The table's draft state and version now, read right before the write. */
export async function readFreshState(
  tableId: string,
): Promise<{ version: number; hasDraft: boolean; draftRev: number } | null> {
  const [r] = await db
    .select({
      version: tables.version,
      draftRev: tables.draftRev,
      hasDraft: sql<boolean>`(${tables.draftPath} is not null or ${tables.draftData} is not null)`,
    })
    .from(tables)
    .where(eq(tables.nodeId, tableId))
    .limit(1);
  if (!r) return null;
  return {
    version: Number(r.version),
    hasDraft: r.hasDraft === true,
    draftRev: Number(r.draftRev ?? 0),
  };
}

export type ReindexOutcome =
  | {
      tableId: string;
      result: 'rebuilt';
      tabs: string[];
      snapshot: string | null;
      version: number;
      resummarized: boolean;
    }
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
    // The image check's answers stay with the drawing (same bytes, same
    // revision): read before the rebuild replaces the tabs.
    let checks: Awaited<ReturnType<typeof checksTabOf>> = null;
    try {
      checks = tabs.length ? await checksTabOf(c.ownerId, c.tableId) : null;
    } catch (err) {
      if (!(err instanceof ChecksTabTooLarge)) throw err;
      return {
        tableId: c.tableId,
        result: 'refused',
        reason: `${err.message}, more than a rebuild carries over, so nothing was rebuilt (no answer is dropped): export the tab or delete the rows of older revisions (they no longer apply), then run again`,
      };
    }
    if (checks && !tabs.some((t) => t.name === CHECKS_TAB)) tabs.push(checks);
    if (tabs.length === 0) {
      return {
        tableId: c.tableId,
        result: 'failed',
        reason: 'the CAD pass gave no tabs (not a readable drawing); the table is unchanged',
      };
    }
    // Read again now: the CAD pass took a while, and someone may have
    // opened a draft or committed meanwhile. The candidate read is stale.
    const now = await readFreshState(c.tableId);
    if (!now) return { tableId: c.tableId, result: 'failed', reason: 'the table is gone' };
    if (now.hasDraft) {
      return {
        tableId: c.tableId,
        result: 'refused',
        reason:
          'a draft was opened on the table during the run: commit or discard it, then run again',
      };
    }
    if (now.version !== c.version) {
      return {
        tableId: c.tableId,
        result: 'refused',
        reason: 'the table was committed during the run: run again to judge the new version',
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
    const saved = await saveTableDraft(
      c.ownerId,
      c.tableId,
      { tabs },
      { replace: true, ifRev: now.draftRev },
    );
    if (!saved || !saved.ok) {
      return saved && !saved.ok
        ? {
            tableId: c.tableId,
            result: 'refused',
            reason:
              'the table changed while the draft was written (a draft or a commit): nothing written, run again',
          }
        : {
            tableId: c.tableId,
            result: 'failed',
            reason: 'the draft could not be written; nothing committed',
          };
    }
    const resummarized = needsResummary(c.description, description ?? null, opts);
    let committed: Awaited<ReturnType<typeof commitTable>> = null;
    try {
      committed = await commitTable(c.ownerId, c.tableId, undefined, {
        keepSummary: !resummarized,
        note: 'dwg-reindex',
      });
    } catch (err) {
      await discardTableDraft(c.ownerId, c.tableId).catch(() => false);
      return {
        tableId: c.tableId,
        result: 'failed',
        reason: `the commit failed (${errorMessage(err).slice(0, 200)}); the replacement draft was discarded`,
      };
    }
    if (!committed) {
      await discardTableDraft(c.ownerId, c.tableId).catch(() => false);
      return {
        tableId: c.tableId,
        result: 'failed',
        reason: 'the commit found no table; the replacement draft was discarded',
      };
    }
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
            // The bytes the new tabs came from: the drawing's revision now.
            [DWG_SOURCE_SHA_KEY]: dwgSourceSha(file.bytes),
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
      resummarized,
    };
  } catch (err) {
    return { tableId: c.tableId, result: 'failed', reason: errorMessage(err).slice(0, 300) };
  }
}
