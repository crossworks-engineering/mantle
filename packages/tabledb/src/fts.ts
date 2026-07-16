import type { Column } from './doc-types';
import { storageType } from './doc-types';
import { quoteIdent } from './names';
import type { SqliteDb } from './sqlite';

/**
 * FTS5 trigram shadows — the in-file fuzzy-search layer (plan §3.2). One
 * shadow table per data table (`<physical>_fts`, external-content), covering
 * the text-ish columns, trigger-maintained so P3's incremental ops keep it
 * current for free.
 *
 * Shadows are built on PUBLISHED writes only (create/import/commit), never on
 * draft rebuilds — the P0 benchmark put the trigram build at ~0.5s for 10k
 * rows, which is fine once per commit and unacceptable on every 1.2s-debounced
 * autosave.
 *
 * Trigram MATCH footgun (probe-pinned): bare terms containing '-' are FTS5
 * syntax errors. quoteFtsTerm is the quoter every engine-side MATCH goes
 * through; table_sql's grounding teaches agents the same rule.
 */

/** Column types whose values are text-shaped enough to be worth indexing. */
const FTS_TYPES = new Set(['text', 'select', 'url', 'multiselect', 'date', 'datetime', 'reference']);

export function ftsColumns(columns: Column[]): Column[] {
  // A linked column indexes by its STORAGE type — a linked-checkbox is a
  // boolean (not FTS'd), a linked-select is text (FTS'd) (v2.2).
  return columns.filter((c) => FTS_TYPES.has(storageType(c)));
}

/** Shadow-table name for a physical data table. */
export function ftsTableName(physicalTable: string): string {
  return `${physicalTable}_fts`;
}

/** Double-quote a user term for FTS5 MATCH (handles '-', '.', spaces — every
 *  shape a part number or tag id takes). Embedded quotes are doubled. */
export function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/**
 * Create the shadow + sync triggers for one data table. Call BEFORE bulk row
 * insert (the insert trigger populates the index in the same pass — no
 * separate rebuild scan).
 */
export function createFtsShadow(db: SqliteDb, physicalTable: string, physicals: string[]): void {
  if (physicals.length === 0) return;
  const fts = ftsTableName(physicalTable);
  const cols = physicals.join(', ');
  const newVals = physicals.map((c) => `new.${c}`).join(', ');
  const oldVals = physicals.map((c) => `old.${c}`).join(', ');
  db.exec(
    `CREATE VIRTUAL TABLE ${fts} USING fts5(${cols}, content=${quoteIdent(physicalTable)}, tokenize='trigram')`,
  );
  db.exec(`CREATE TRIGGER ${physicalTable}_fts_ai AFTER INSERT ON ${physicalTable} BEGIN
    INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.rowid, ${newVals});
  END`);
  db.exec(`CREATE TRIGGER ${physicalTable}_fts_ad AFTER DELETE ON ${physicalTable} BEGIN
    INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.rowid, ${oldVals});
  END`);
  db.exec(`CREATE TRIGGER ${physicalTable}_fts_au AFTER UPDATE ON ${physicalTable} BEGIN
    INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.rowid, ${oldVals});
    INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.rowid, ${newVals});
  END`);
}
