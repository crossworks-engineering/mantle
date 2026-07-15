import { loadCell } from './cells';
import type { CellValue, Column, ColumnType, Row } from './doc-types';
import { openTableFile, type SqliteDb } from './sqlite';

/**
 * L1 deterministic profile (plan §6, as amended 2026-07-15): pure SQL over the
 * workbook file, no LLM, cheap enough to refresh on every commit. This is what
 * the brain indexes for a table — column names, types, top-N distinct values,
 * counts — because those are what real lookups key off (NATREF audit evidence:
 * exact-term hits ride column names and categorical values, not row bodies).
 * Rows are NEVER embedded; deep row lookup is table_sql's job.
 */

export type ColumnProfile = {
  colId: string;
  name: string;
  type: ColumnType;
  distinctCount: number;
  /** 0..1 share of rows where this cell is empty. */
  nullRate: number;
  /** Numeric/date range when the type orders (min/max as stored text/number). */
  min?: string | number;
  max?: string | number;
  /** Most frequent values (categorical routing fodder). Suppressed for
   *  identifier-like columns — top-N of a unique column is just a row dump. */
  topValues: { value: string; count: number }[];
  /** Nearly every value distinct — a key/tag/id column. Lookups on it belong
   *  in table_sql (FTS/LIKE), not the chunk index. */
  identifierLike?: boolean;
  avgTextLen?: number;
  /** Long-form text column (sentences, not identifiers). */
  prose?: boolean;
  /** date/datetime column carrying values that didn't normalize to ISO. */
  mixedDates?: boolean;
  /** type='reference': the cross-tab source, resolved to display names. */
  refersTo?: { tab: string; column: string };
  /** type='reference': distinct non-empty values ABSENT from the source
   *  column (Excel-style soft integrity — flagged, never blocked). */
  danglingRefs?: number;
};

export type TabProfile = {
  tabId: string;
  name: string;
  rowCount: number;
  columns: ColumnProfile[];
};

const TOP_N = 8;
const RANGED = new Set<ColumnType>(['number', 'currency', 'percent', 'date', 'datetime']);
const TEXTY = new Set<ColumnType>(['text', 'url', 'reference']);

type ColRow = { col_id: string; physical: string; name: string; type: string };

function profileColumn(db: SqliteDb, table: string, rowCount: number, col: ColRow): ColumnProfile {
  const type = col.type as ColumnType;
  const p = col.physical;
  const out: ColumnProfile = {
    colId: col.col_id,
    name: col.name,
    type,
    distinctCount: 0,
    nullRate: rowCount === 0 ? 0 : 1,
    topValues: [],
  };
  if (type === 'formula' || rowCount === 0) return out;

  const base = db
    .prepare(`SELECT count(DISTINCT ${p}) AS d, count(${p}) AS filled FROM ${table}`)
    .get() as { d: number; filled: number };
  out.distinctCount = Number(base.d);
  out.nullRate = Math.round(((rowCount - Number(base.filled)) / rowCount) * 1000) / 1000;

  if (RANGED.has(type)) {
    const mm = db.prepare(`SELECT min(${p}) AS lo, max(${p}) AS hi FROM ${table} WHERE ${p} IS NOT NULL`).get() as
      | { lo: string | number | null; hi: string | number | null }
      | undefined;
    if (mm?.lo != null) out.min = mm.lo;
    if (mm?.hi != null) out.max = mm.hi;
  }
  if ((type === 'date' || type === 'datetime') && Number(base.filled) > 0) {
    const bad = db
      .prepare(
        `SELECT count(*) AS n FROM ${table} WHERE ${p} IS NOT NULL AND ${p} NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`,
      )
      .get() as { n: number };
    if (Number(bad.n) > 0) out.mixedDates = true;
  }
  const identifierLike = rowCount > TOP_N && out.distinctCount >= Number(base.filled) * 0.9;
  if (identifierLike && (TEXTY.has(type) || type === 'select' || type === 'multiselect')) {
    out.identifierLike = true;
  } else if (TEXTY.has(type) || type === 'select' || type === 'multiselect') {
    const top = db
      .prepare(
        `SELECT ${p} AS v, count(*) AS n FROM ${table} WHERE ${p} IS NOT NULL GROUP BY ${p} ORDER BY n DESC, v LIMIT ${TOP_N}`,
      )
      .all() as { v: unknown; n: number }[];
    out.topValues = top.map((t) => ({ value: String(t.v).slice(0, 120), count: Number(t.n) }));
  }
  if (TEXTY.has(type)) {
    const len = db.prepare(`SELECT avg(length(${p})) AS l FROM ${table} WHERE ${p} IS NOT NULL`).get() as {
      l: number | null;
    };
    if (len.l != null) {
      out.avgTextLen = Math.round(Number(len.l));
      if (out.avgTextLen > 60) out.prose = true;
    }
  }
  return out;
}

/** Profile every tab of a workbook file. Pure reads (readOnly open). */
export function profileFile(absPath: string): TabProfile[] {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const tabs = db.prepare(`SELECT tab_id, name, physical_table FROM _tabs ORDER BY position`).all() as unknown as {
      tab_id: string;
      name: string;
      physical_table: string;
    }[];
    const tabNameById = new Map(tabs.map((t) => [t.tab_id, t.name]));
    const tableByTabId = new Map(tabs.map((t) => [t.tab_id, t.physical_table]));
    const allCols = db.prepare(`SELECT * FROM _columns`).all() as unknown as (ColRow & { ref_json?: string | null })[];
    const colById = new Map(allCols.map((c) => [c.col_id, c]));
    return tabs.map((tab) => {
      const rowCount = Number(db.prepare(`SELECT count(*) AS n FROM ${tab.physical_table}`).get()?.n ?? 0);
      // SELECT * — pre-v2.1 files have no ref_json column.
      const cols = db
        .prepare(`SELECT * FROM _columns WHERE tab_id = ? ORDER BY position`)
        .all(tab.tab_id) as unknown as (ColRow & { ref_json?: string | null })[];
      return {
        tabId: tab.tab_id,
        name: tab.name,
        rowCount,
        columns: cols.map((c) => {
          const out = profileColumn(db, tab.physical_table, rowCount, c);
          if (c.type === 'reference' && c.ref_json != null) {
            const ref = JSON.parse(String(c.ref_json)) as { tabId: string; columnId: string };
            const srcCol = colById.get(ref.columnId);
            const srcTable = tableByTabId.get(ref.tabId);
            const srcTabName = tabNameById.get(ref.tabId);
            if (srcCol && srcTable && srcTabName) {
              out.refersTo = { tab: srcTabName, column: srcCol.name };
              const dangling = Number(
                db
                  .prepare(
                    `SELECT count(DISTINCT ${c.physical}) AS n FROM ${tab.physical_table}
                     WHERE ${c.physical} IS NOT NULL AND CAST(${c.physical} AS TEXT) != ''
                       AND ${c.physical} NOT IN (
                         SELECT ${srcCol.physical} FROM ${srcTable} WHERE ${srcCol.physical} IS NOT NULL
                       )`,
                  )
                  .get()?.n ?? 0,
              );
              if (dangling > 0) out.danglingRefs = dangling;
            }
          }
          return out;
        }),
      };
    });
  } finally {
    db.close();
  }
}

/** ~n rows per tab, stratified over the row order (every k-th row) — the L2
 *  overview's sample. Returns doc-shaped rows (cells keyed by column id). */
export function sampleRows(absPath: string, n = 20): { tabId: string; rows: Row[] }[] {
  const db = openTableFile(absPath, { readOnly: true });
  try {
    const tabs = db.prepare(`SELECT tab_id, physical_table FROM _tabs ORDER BY position`).all() as unknown as {
      tab_id: string;
      physical_table: string;
    }[];
    return tabs.map((tab) => {
      const total = Number(db.prepare(`SELECT count(*) AS c FROM ${tab.physical_table}`).get()?.c ?? 0);
      const cols = db
        .prepare(`SELECT col_id, physical, type FROM _columns WHERE tab_id = ? AND type != 'formula' ORDER BY position`)
        .all(tab.tab_id) as unknown as { col_id: string; physical: string; type: string }[];
      if (total === 0 || cols.length === 0) return { tabId: tab.tab_id, rows: [] };
      const k = Math.max(1, Math.ceil(total / n));
      const select = cols.map((c) => c.physical).join(', ');
      const raw = db
        .prepare(
          `SELECT _rid, ${select} FROM (
             SELECT *, ROW_NUMBER() OVER (ORDER BY _pos, _rid) AS rn FROM ${tab.physical_table}
           ) WHERE (rn - 1) % ${k} = 0 ORDER BY rn LIMIT ${n}`,
        )
        .all();
      const rows: Row[] = raw.map((r) => {
        const cells: Record<string, CellValue> = {};
        for (const c of cols) {
          const v = loadCell(r[c.physical], c.type as ColumnType);
          if (v !== null) cells[c.col_id] = v;
        }
        return { id: String(r._rid), cells };
      });
      return { tabId: tab.tab_id, rows };
    });
  } finally {
    db.close();
  }
}

function fmtRange(p: ColumnProfile): string {
  if (p.min === undefined && p.max === undefined) return '';
  return `, range ${String(p.min)} → ${String(p.max)}`;
}

/**
 * The profile rendered as indexable text — THE chunk source for tables (plus
 * the L2 overview). Sections split on '## ' headings so the chunker can emit
 * one chunk per tab.
 */
export function profileToText(profiles: TabProfile[], opts: { title: string; columns?: Column[] }): string {
  const lines: string[] = [];
  const tabSummary = profiles.map((t) => `${t.name} (${t.rowCount} rows × ${t.columns.length} cols)`).join(', ');
  lines.push(`# ${opts.title} — table profile`);
  lines.push(`Tabs: ${tabSummary || 'none'}.`);
  for (const tab of profiles) {
    lines.push('');
    lines.push(`## ${tab.name} — ${tab.rowCount} rows`);
    lines.push(`Columns: ${tab.columns.map((c) => `${c.name} (${c.type})`).join(', ')}.`);
    for (const c of tab.columns) {
      if (c.type === 'formula') {
        lines.push(`- ${c.name}: formula column (computed).`);
        continue;
      }
      const bits: string[] = [`${c.distinctCount} distinct`];
      if (c.nullRate > 0) bits.push(`${Math.round(c.nullRate * 100)}% empty`);
      const range = fmtRange(c);
      if (range) bits.push(range.slice(2));
      if (c.prose) bits.push(`long text (avg ${c.avgTextLen} chars)`);
      if (c.identifierLike) bits.push('mostly unique values (identifier-like — look up specific values with table_sql)');
      if (c.mixedDates) bits.push('MIXED DATE FORMATS (some values not ISO)');
      if (c.refersTo) bits.push(`references ${c.refersTo.tab}.${c.refersTo.column} (cross-tab join key)`);
      if (c.danglingRefs) bits.push(`DANGLING REFS (${c.danglingRefs} value(s) missing from the source column)`);
      let line = `- ${c.name} (${c.type}): ${bits.join(', ')}`;
      if (c.topValues.length > 0) {
        line += `. Top values: ${c.topValues.map((t) => `${t.value} (${t.count})`).join(', ')}`;
      }
      lines.push(line);
    }
  }
  return lines.join('\n');
}
