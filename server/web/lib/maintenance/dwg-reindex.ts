/**
 * The `dwg-reindex` maintenance task, by its two modes.
 *
 * Database mode, the default (its own header, further down): build a table-type
 * file's read-only database from its bytes. No model, no Table.
 *
 * Table mode, only ever asked for by name (`--table`, and `--may-spend` to
 * apply it): rebuild the auto-import workbook of DWG/DXF files IN PLACE, so a drawing
 * imported before the bones tabs (Segments, Nodes, Inserts, Circuits) gains
 * them without losing its table. The SAME table node keeps its id, so
 * links, grants, workspace placement, title and tags all survive; only its
 * workbook tabs and its description are rebuilt, from a fresh CAD pass
 * over the file's bytes (the same builder as the first import,
 * @mantle/files/dwg `cadRegistryWorkbook`).
 *
 * Manual only: `scripts/dwg-reindex.ts --table`, scoped by file id or folder, a
 * per-run cap, dry run by default. No cron, no trigger, nothing that runs on its
 * own.
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
 * A Checks tab an older image check left (nothing reads it now: the answers are
 * on the file row) is carried through a rebuild as it is, as a person's data. The
 * table's `sourceSha256` is stamped with the bytes the rebuild read. A check
 * commit of that older image check (`dwgCheckedVersion`) on an unedited table is
 * not an edit.
 *
 * Output is counts and ids only: safe on a client box.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, nodes, tables, withHeads } from '@mantle/db';
import { commitTable, discardTableDraft, saveTableDraft } from '@mantle/content';
import { buildFileDatabase, parseFileSheets, tabsOfSheets } from '@mantle/content/file-database';
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
import { describeWorkbook, readDocFile, TableTooLargeError } from '@mantle/tabledb';
import {
  fileDataExt,
  fileDataListKeys,
  fileDataRow,
  fileDbsWritable,
  fileDbSqlitePath,
  fileSha256Of,
  isFileSha256,
  isParserError,
  listFileDbFolder,
  loadFileHead,
  PARSER_COUNTED_CODES,
  privateFileIds,
  readFileById,
  readFileDbNone,
  readFileNodeBytes,
  removeFileDbEntry,
  resolveEffectiveIndexing,
  STAGED_LEFTOVER_MIN_AGE_MS,
  tableFileFilter,
} from '@mantle/files';
import { mspdiRootPresent } from '@mantle/files/mspdi-sniff';
import { envNum } from '@mantle/config';
import { errorMessage, isUuid } from '@mantle/std';

/** A row of a brain's own space: an extract reads no other (not_brain_owner). */
const inBrainSpace = () => sql`public.mantle_is_brain_space(${nodes.ownerId})`;

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
    inBrainSpace(),
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
  const tabs = tabsOfSheets(grids.sheets.slice(0, envNum('MANTLE_MAX_AUTO_TABLE_TABLES')));
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

/* ─── database mode ──────────────────────────────────────────────────────────
 *
 * Give table-type files their read-only database (packages/content/src/
 * file-database.ts): by id order, the whole box or by file or folder, at most
 * `--limit` files read a run, one at a time, dry run by default. Never by itself:
 * an owner's word at a terminal, on a box through scripts/box-maintain.sh
 * --files-writable. No model is reached, and no Table is read or written.
 *
 * It takes a missing name; `--again` also replaces a word. `--after=<id>` goes on
 * from the last run, so a file it skips, or one that kills the run, cannot use up
 * the cap: the id is printed before the read, so the log names the killer.
 *
 * Output is ids, counts and fixed words: safe on a client box. Never a file's
 * title, a tab's name or a cell. So an error is its code alone, as a parser or a
 * driver may quote what it read.
 */

export const REBUILD_DEFAULT_LIMIT = 100;
export const REBUILD_MAX_LIMIT = 1000;
/** Rows read at a time to find the next file to take. */
const REBUILD_PAGE = 500;

export type RebuildOptions = {
  scope: ReindexScope;
  after?: string;
  limit: number;
  again: boolean;
  apply: boolean;
};

type Print = (line: string) => void;

/** A run's counters, printed in the order they first moved. */
class Counts extends Map<string, number> {
  add(key: string) {
    this.set(key, (this.get(key) ?? 0) + 1);
  }
  get text() {
    return [...this].map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing';
  }
}

/** Where a page of candidates may come from: the brain's own rows, in scope. */
function rowsInScope(scope: ReindexScope, after?: string): (SQL | undefined)[] {
  const files = (scope.fileIds ?? []).filter(Boolean);
  return [
    tableFileFilter({ xml: true }),
    inBrainSpace(),
    files.length ? inArray(nodes.id, files) : undefined,
    scope.folderId
      ? sql`${nodes.path} <@ (select p.path from ${nodes} p where p.id = ${scope.folderId} and p.type = 'branch')`
      : undefined,
    after ? gt(nodes.id, after) : undefined,
  ];
}

/** The next page of candidates, by id. Their keys only: a `data` bag can hold a
 *  document's text. */
function candidatePage(scope: ReindexScope, after?: string) {
  return db
    .select({
      id: nodes.id,
      ownerId: nodes.ownerId,
      path: nodes.path,
      data: fileDataListKeys(),
      updatedAt: nodes.updatedAt,
    })
    .from(nodes)
    .where(and(...rowsInScope(scope, after)))
    .orderBy(asc(nodes.id))
    .limit(REBUILD_PAGE);
}

type Candidate = Awaited<ReturnType<typeof candidatePage>>[number];

/** What a run does with this row, reading no bytes. `named`: it has what it
 *  needs, and costs nothing, so it is counted and not listed. */
async function planFor(
  row: Candidate,
  again: boolean,
): Promise<{ take: true } | { take: false; named: string } | { take: false; skip: string }> {
  const sha = fileSha256Of(row);
  if (!isFileSha256(sha)) return { take: false, skip: 'no-sha' };
  if (await fileDbSqlitePath(row.id, sha)) return { take: false, named: 'already built' };
  if (!again && (await readFileDbNone(row.id, sha))) {
    return { take: false, named: 'already have a word' };
  }
  const { effective } = await resolveEffectiveIndexing(row.ownerId, row);
  return effective === 'metadata' ? { take: false, skip: 'private' } : { take: true };
}

/** Parse, and once more on a code that counts against the bytes: the count lives
 *  in this process (parser-client.ts), so the second failure earns its word in
 *  this run. Any other failure says nothing about the file and throws. */
async function parseWithRetry(bytes: Buffer, ext: string) {
  try {
    return await parseFileSheets(bytes, ext);
  } catch (err) {
    if (!isParserError(err) || !PARSER_COUNTED_CODES.has(err.code)) throw err;
    return parseFileSheets(bytes, ext);
  }
}

/** Read one file and build. Never throws, and writes nothing on any failure.
 *  What comes back is a fixed word, safe to print. */
async function rebuildFile(row: Candidate): Promise<{ key: string; line: string }> {
  const skip = (reason: string) => ({ key: `skipped ${reason}`, line: `skipped: ${reason}` });
  try {
    const full = await fileDataRow(row.ownerId, row.id);
    if (!full) return skip('row-gone');
    const ext = fileDataExt(full);
    // C1: the root element answers for most XML, with no whole-file read. An
    // unreadable head is no evidence, and the whole read decides.
    if (ext === 'xml') {
      const head = await loadFileHead(full);
      if (head && !mspdiRootPresent(head)) return skip('not-plan');
    }
    const loaded = await readFileNodeBytes(full);
    if (!loaded) return skip('bytes-gone');
    const sha = fileSha256Of(full);
    if (createHash('sha256').update(loaded.bytes).digest('hex') !== sha) {
      return skip('sha-differs');
    }
    const built = await buildFileDatabase({
      fileId: row.id,
      ownerId: row.ownerId,
      sha256: sha,
      bytes: loaded.bytes,
      filename: loaded.filename,
      parsed: await parseWithRetry(loaded.bytes, ext),
    });
    if (built.status === 'built') {
      return { key: 'built', line: `built (${built.tabs} tabs, ${built.rows} rows)` };
    }
    if (built.status === 'none') return { key: `word ${built.word}`, line: `word: ${built.word}` };
    return skip(built.reason);
  } catch (err) {
    if (isParserError(err)) {
      return { key: `parser ${err.code}`, line: `nothing written: parser ${err.code}` };
    }
    const code = (err as { code?: unknown } | null)?.code;
    const named = typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'error';
    return { key: `failed ${named}`, line: `nothing written: failed ${named}` };
  }
}

/** One run of the database mode. The cap counts files read, so a row with its
 *  name, or one that needs no read to refuse, uses none of it. */
export async function runDatabaseRebuild(
  opts: RebuildOptions,
  print: Print,
): Promise<{ counts: Counts; last: string | null; cut: boolean }> {
  const counts = new Counts();
  const named = new Set((opts.scope.fileIds ?? []).filter(Boolean));
  let after = opts.after;
  let read = 0;
  let cut = false;
  let last: string | null = null;
  walk: for (;;) {
    const page = await candidatePage(opts.scope, after);
    for (const row of page) {
      named.delete(row.id);
      const plan = await planFor(row, opts.again);
      if (plan.take) {
        if (read >= opts.limit) {
          cut = true;
          break walk;
        }
        read += 1;
      }
      last = row.id;
      if (!plan.take) {
        if ('named' in plan) counts.add(plan.named);
        else {
          counts.add(`skipped ${plan.skip}`);
          print(`  ${row.id}: skipped: ${plan.skip}`);
        }
      } else if (opts.apply) {
        print(`  ${row.id}: reading`);
        const out = await rebuildFile(row);
        counts.add(out.key);
        print(`  ${row.id}: ${out.line}`);
      } else {
        counts.add('to read');
        print(`  ${row.id}: would read`);
      }
    }
    if (page.length < REBUILD_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  for (const id of cut ? [] : named) {
    counts.add('skipped not-a-candidate');
    print(`  ${id}: skipped: not-a-candidate`);
  }
  return { counts, last, cut };
}

/** A name on disk nothing should read any more, and why. */
export type FileDbOrphan = {
  name: string;
  bytes: number;
  why: 'no-row' | 'sha-differs' | 'private' | 'old-build';
};

/**
 * The names with no live row, of bytes the row no longer holds, of a private
 * row, and `.build-*` residue past the staged sweep's hour. The folder is read
 * before the rows, so a row is never older than a name it is judged against.
 */
export async function findFileDbOrphans(now = Date.now()): Promise<FileDbOrphan[]> {
  const { names, builds } = await listFileDbFolder();
  const ids = [...new Set(names.map((n) => n.fileId))].filter((id) => isUuid(id));
  const rows: Candidate[] = [];
  for (let i = 0; i < ids.length; i += REBUILD_PAGE) {
    rows.push(
      ...(await db
        .select({
          id: nodes.id,
          ownerId: nodes.ownerId,
          path: nodes.path,
          data: fileDataListKeys(),
          updatedAt: nodes.updatedAt,
        })
        .from(nodes)
        .where(and(eq(nodes.type, 'file'), inArray(nodes.id, ids.slice(i, i + REBUILD_PAGE))))),
    );
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hidden = new Set<string>();
  for (const owner of new Set(rows.map((r) => r.ownerId))) {
    const held = rows.filter((r) => r.ownerId === owner);
    for (const id of await privateFileIds(owner, held)) hidden.add(id);
  }
  const orphans: FileDbOrphan[] = [];
  for (const n of names) {
    // A name that is no file id is no name of this folder's: left alone.
    if (!isUuid(n.fileId)) continue;
    const row = byId.get(n.fileId);
    const sha = row && fileSha256Of(row);
    const why = !row
      ? 'no-row'
      : !isFileSha256(sha) || sha.slice(0, 16) !== n.sha16
        ? 'sha-differs'
        : hidden.has(n.fileId)
          ? 'private'
          : null;
    if (why) orphans.push({ name: n.name, bytes: n.bytes, why });
  }
  for (const b of builds) {
    if (now - b.mtimeMs >= STAGED_LEFTOVER_MIN_AGE_MS) {
      orphans.push({ name: b.name, bytes: b.bytes, why: 'old-build' });
    }
  }
  return orphans;
}

/** The auto-import Table of a file, as the rebuild and `--count` read it: a
 *  person's own table made from it holds what the person left there. */
async function oldTableOf(ownerId: string, fileId: string) {
  const [row] = await db
    .select({
      id: nodes.id,
      createdAt: nodes.createdAt,
      stamp: sql<string | null>`${nodes.data}->>${DWG_SOURCE_SHA_KEY}::text`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'table'),
        sql`'auto-import' = ANY(${nodes.tags})`,
        sql`${nodes.data}->>'sourceFileId' = ${fileId}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The extract that makes a Table writes the file row after it, so a write this
 *  soon after the Table says nothing about the bytes. */
const TABLE_EXTRACT_MARGIN_MS = 60 * 60 * 1000;

/** Whether a file changed after its old Table was made. A drawing's stamp says
 *  so exactly. With no stamp only the dates can, and any later write counts. */
function replacedSinceTable(
  file: Pick<Candidate, 'data' | 'updatedAt'>,
  table: { createdAt: Date; stamp: string | null },
): boolean {
  if (table.stamp) return table.stamp !== fileSha256Of(file);
  return file.updatedAt.getTime() - table.createdAt.getTime() > TABLE_EXTRACT_MARGIN_MS;
}

/**
 * Rows per tab, old Table against database, for the files in scope that have an
 * old Table. Each old tab but Checks must match, and a file with an old Table and
 * no database fails, unless it is private, which is only counted; a database's
 * extra tabs are only listed. A file whose rows differ because it changed after
 * its Table was made is only counted, as `replaced`: that Table holds older rows
 * by design. Numbers only: a tab is its position in the old Table, never its name.
 */
export async function runCount(scope: ReindexScope, print: Print): Promise<boolean> {
  const counts = new Counts();
  let after: string | undefined;
  for (;;) {
    const page = await candidatePage(scope, after);
    for (const row of page) {
      const table = await oldTableOf(row.ownerId, row.id);
      if (!table) continue;
      // It stays out, so it has no database by design: no difference.
      const { effective } = await resolveEffectiveIndexing(row.ownerId, row);
      if (effective === 'metadata') {
        counts.add('private');
        continue;
      }
      counts.add('files');
      const problems: string[] = [];
      try {
        const abs = await fileDbSqlitePath(row.id, fileSha256Of(row));
        const old = await tableSqlSurface(row.ownerId, table.id);
        if (!abs) problems.push('no database');
        if (!old) problems.push('no old workbook');
        if (abs && old) {
          const fresh = new Map(describeWorkbook(abs).map((t) => [t.name, t.rowCount]));
          const differs: string[] = [];
          old.tabs.forEach((tab, i) => {
            if (tab.name === CHECKS_TAB) return;
            counts.add('tabs');
            const now = fresh.get(tab.name);
            fresh.delete(tab.name);
            if (now === undefined) differs.push(`tab ${i + 1}: old ${tab.rowCount}, no such tab`);
            else if (now !== tab.rowCount) {
              differs.push(`tab ${i + 1}: old ${tab.rowCount}, database ${now}`);
            }
          });
          if (differs.length && replacedSinceTable(row, table)) counts.add('replaced');
          else problems.push(...differs);
          if (fresh.size) {
            counts.add('files with extra tabs');
            print(`  ${row.id}: ${fresh.size} extra tabs in the database`);
          }
        }
      } catch {
        problems.push('could not be read');
      }
      if (problems.length) {
        counts.add('files that differ');
        print(`  ${row.id}: ${problems.join('; ')}`);
      }
    }
    if (page.length < REBUILD_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  const pass = !counts.has('files that differ');
  print(`[dwg-reindex] count: ${counts.text}: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

/* ─── the command line ─────────────────────────────────────────────────────── */

const flagOf = (argv: readonly string[], name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

function scopeOf(argv: readonly string[]): ReindexScope {
  const folder = flagOf(argv, 'folder');
  return {
    fileIds: (flagOf(argv, 'file') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(folder ? { folderId: folder.trim() } : {}),
  };
}

const READ_ONLY_FOLDER =
  'the files folder is read-only here: on a box, run this with scripts/box-maintain.sh --files-writable. Nothing done.';

async function runOrphans(apply: boolean, print: Print): Promise<number> {
  if (apply && !(await fileDbsWritable())) {
    print(`[dwg-reindex] ${READ_ONLY_FOLDER}`);
    return 1;
  }
  const { names } = await listFileDbFolder();
  const orphans = await findFileDbOrphans();
  // Names, and not one row for any of them: this is the wrong database.
  const fileNames = names.filter((n) => isUuid(n.fileId)).length;
  if (apply && fileNames && orphans.filter((o) => o.why === 'no-row').length >= fileNames) {
    print(
      `[dwg-reindex] ${fileNames} names in the folder and no row for any of them: check DATABASE_URL against this box's files. Nothing removed.`,
    );
    return 1;
  }
  const counts = new Counts();
  let bytes = 0;
  for (const o of orphans) {
    counts.add(o.why);
    bytes += o.bytes;
    print(`  ${o.name}: ${o.why} (${o.bytes} bytes)`);
    if (apply) await removeFileDbEntry(o.name);
  }
  const { builds } = await listFileDbFolder();
  if (!apply) {
    print(
      `[dwg-reindex] orphans: ${counts.text}, ${bytes} bytes${orphans.length ? '. DRY RUN: pass --apply to remove them' : ''}`,
    );
    return 0;
  }
  print(
    `[dwg-reindex] orphans: removed ${orphans.length} (${counts.text}), ${bytes} bytes; ${builds.length} .build-* left, each a write in flight or under an hour old`,
  );
  return 0;
}

async function runDatabaseMode(argv: readonly string[], print: Print): Promise<number> {
  const table = ['--keep-edits', '--resummarize', '--may-spend'].find((f) => argv.includes(f));
  if (table) {
    print(`[dwg-reindex] ${table} is for --table mode. Nothing done.`);
    return 2;
  }
  const apply = argv.includes('--apply');
  if (argv.includes('--orphans')) {
    // The list is the whole box's: a narrowing word would not narrow the removal.
    const narrow = ['file', 'folder', 'after'].find((name) => flagOf(argv, name) !== undefined);
    if (narrow) {
      print(`[dwg-reindex] --orphans is for the whole box: it takes no --${narrow}. Nothing done.`);
      return 2;
    }
    return runOrphans(apply, print);
  }
  const scope = scopeOf(argv);
  const after = flagOf(argv, 'after');
  const bad = [...(scope.fileIds ?? []), ...(scope.folderId ? [scope.folderId] : []), after].find(
    (id) => id !== undefined && !isUuid(id),
  );
  if (bad !== undefined) {
    print(`[dwg-reindex] not an id: ${bad}. Nothing done.`);
    return 2;
  }
  if (argv.includes('--count')) return (await runCount(scope, print)) ? 0 : 1;
  const asked = flagOf(argv, 'limit');
  const limit = asked
    ? Math.max(1, Math.min(REBUILD_MAX_LIMIT, Math.floor(Number(asked)) || REBUILD_DEFAULT_LIMIT))
    : REBUILD_DEFAULT_LIMIT;
  if (apply && !(await fileDbsWritable())) {
    print(`[dwg-reindex] ${READ_ONLY_FOLDER}`);
    return 1;
  }
  const { counts, last, cut } = await runDatabaseRebuild(
    { scope, limit, apply, again: argv.includes('--again'), ...(after ? { after } : {}) },
    print,
  );
  print(`[dwg-reindex] ${apply ? 'done' : 'DRY RUN'}: ${counts.text}`);
  if (cut) print(`[dwg-reindex] cut at --limit=${limit}; go on with --after=${last}`);
  else if (last) print(`[dwg-reindex] the end of the list; the last id was ${last}`);
  if (!apply) print('[dwg-reindex] pass --apply to build them');
  return 0;
}

/** The table mode, by name. It can pay, through needsResummary, so its live run
 *  needs its own word: the runner's --yes follows the task's cost, and the task
 *  as a whole spends nothing. */
async function runTableMode(argv: readonly string[], print: Print): Promise<number> {
  const apply = argv.includes('--apply');
  const keepEdits = argv.includes('--keep-edits');
  const resummarize = argv.includes('--resummarize');
  const again = argv.includes('--again');
  const asked = flagOf(argv, 'limit');
  const limit = clampLimit(asked ? Number(asked) : null);
  const scope = scopeOf(argv);
  const problem = scopeProblem(scope);
  if (problem) {
    print(`[dwg-reindex] ${problem}. Nothing done.`);
    return 2;
  }
  if (apply && !argv.includes('--may-spend')) {
    print(
      '[dwg-reindex] a live --table run can pay for a model call per table: pass --may-spend too. Nothing done.',
    );
    return 2;
  }
  const found = await findReindexCandidates(scope, limit, { again });
  const cut = found.length > limit;
  const chosen = found.slice(0, limit);
  print(
    `[dwg-reindex] candidates in scope: ${chosen.length}${cut ? ` (cut at --limit=${limit}; run again for the rest)` : ''}${again ? '' : ' (tables already rebuilt are skipped; --again includes them)'}`,
  );
  if (chosen.length === 0) return 0;
  for (const c of chosen) {
    const d = decide(c, { keepEdits });
    const has = c.tabs.includes('Segments') ? 'has the bones tabs' : 'no bones tabs';
    const plan =
      d.action === 'refuse'
        ? `refuse (${d.reason})`
        : d.snapshotFirst
          ? 'snapshot, then rebuild'
          : 'rebuild';
    print(`  ${c.tableId} (file ${c.fileId}, v${c.version}, ${has}): ${plan}`);
  }
  const rewrite = chosen.filter((c) => needsResummary(c.description, null, { resummarize })).length;
  print(
    `  summary: ${resummarize ? 'the full extractor pass runs (one model call per table)' : `kept (no model pass; the vector and profile are rebuilt), except ${rewrite} table${rewrite === 1 ? '' : 's'} whose old description says no vector geometry: rewritten (one model call each)`}`,
  );
  if (!apply) {
    print('[dwg-reindex] DRY RUN: pass --apply --may-spend to rebuild them');
    return 0;
  }
  const counts = { rebuilt: 0, refused: 0, failed: 0 };
  for (const c of chosen) {
    const r = await rebuildOne(c, { keepEdits, resummarize });
    counts[r.result] += 1;
    if (r.result === 'rebuilt') {
      print(
        `  ${r.tableId}: rebuilt as v${r.version} (${r.tabs.length} tabs${r.snapshot ? `, snapshot ${r.snapshot} first` : ''}${r.resummarized ? ', summary rewritten' : ''})`,
      );
    } else {
      print(`  ${r.tableId}: ${r.result}: ${r.reason}`);
    }
  }
  print(
    `[dwg-reindex] done: ${counts.rebuilt} rebuilt, ${counts.refused} refused, ${counts.failed} failed`,
  );
  return 0;
}

/** The task, as scripts/dwg-reindex.ts runs it: the exit code. */
export function runDwgReindex(argv: readonly string[], print: Print): Promise<number> {
  return argv.includes('--table') ? runTableMode(argv, print) : runDatabaseMode(argv, print);
}
