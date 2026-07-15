/**
 * P0 benchmark — cost of the P1 transition's "full draft rebuild per autosave".
 *
 * During P1 the UI keeps its whole-doc PUT autosave (1.2s debounce): every
 * autosave rebuilds the .draft.sqlite from the posted TableDoc instead of
 * applying ops. This measures that rebuild — schema + batched insert +
 * checkpoint + atomic rename — at 1k/5k/10k rows (10k is today's import
 * ceiling, so it bounds the entire P1 universe), with and without the FTS5
 * trigram shadow (P2 adds it; P3 retires the rebuild entirely).
 *
 *   pnpm -C apps/web exec tsx ../../packages/tabledb/bench/autosave-rebuild.mts
 *
 * Record results in the Tables v2 plan/commit — the P1 "accept rebuild cost at
 * ≤10k rows" claim rests on these numbers.
 */
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

const COLS = 8;
const TEXT_COLS = [0, 2, 5]; // columns included in the FTS shadow
const ROW_COUNTS = [1_000, 5_000, 10_000];
const RUNS = 5;

type Row = (string | number)[];

function makeRows(n: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    rows.push([
      `Line item ${i} — pressure vessel V-${1000 + (i % 500)} inspection record`,
      i * 3.25,
      `dept-${i % 12} / area ${i % 40}`,
      i % 2,
      `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      `note ${i}: torque checked, gasket ${i % 7 === 0 ? 'replaced' : 'ok'}, follow-up ${i % 11}`,
      i % 100,
      `REF-${String(i).padStart(6, '0')}`,
    ]);
  }
  return rows;
}

function rebuild(dir: string, rows: Row[], withFts: boolean): number {
  const build = path.join(dir, 'build.sqlite');
  const dest = path.join(dir, 'node.draft.sqlite');
  rmSync(build, { force: true });
  const t0 = performance.now();

  const db = new DatabaseSync(build);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`CREATE TABLE _meta (k TEXT PRIMARY KEY, v TEXT)`);
  db.exec(`CREATE TABLE _tabs (tab_id TEXT PRIMARY KEY, name TEXT, position INTEGER, physical_table TEXT)`);
  db.exec(`CREATE TABLE _columns (tab_id TEXT, col_id TEXT, name TEXT, type TEXT, format TEXT, options_json TEXT, formula_src TEXT, width INTEGER, position INTEGER)`);
  const colDefs = Array.from({ length: COLS }, (_, c) => `c_${c} ${c === 1 || c === 6 ? 'REAL' : 'TEXT'}`).join(', ');
  db.exec(`CREATE TABLE t_tab1 (_rid TEXT PRIMARY KEY, _pos REAL NOT NULL, ${colDefs})`);
  db.exec(`CREATE INDEX t_tab1_pos ON t_tab1(_pos)`);
  if (withFts) {
    const ftsCols = TEXT_COLS.map((c) => `c_${c}`).join(', ');
    db.exec(`CREATE VIRTUAL TABLE t_tab1_fts USING fts5(${ftsCols}, content='t_tab1', tokenize='trigram')`);
    db.exec(`CREATE TRIGGER t_tab1_ai AFTER INSERT ON t_tab1 BEGIN
      INSERT INTO t_tab1_fts(rowid, ${ftsCols}) VALUES (new.rowid, ${TEXT_COLS.map((c) => `new.c_${c}`).join(', ')});
    END`);
  }

  const placeholders = Array.from({ length: COLS }, () => '?').join(', ');
  const ins = db.prepare(`INSERT INTO t_tab1 (_rid, _pos, ${Array.from({ length: COLS }, (_, c) => `c_${c}`).join(', ')}) VALUES (?, ?, ${placeholders})`);
  db.exec('BEGIN');
  for (let i = 0; i < rows.length; i++) {
    ins.run(`r${i}`, i + 1, ...rows[i]);
  }
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  renameSync(build, dest);

  return performance.now() - t0;
}

const dir = mkdtempSync(path.join(tmpdir(), 'tabledb-bench-'));
try {
  console.log(`autosave full-rebuild benchmark — node ${process.version}, ${COLS} cols, ${RUNS} runs (median reported)`);
  for (const withFts of [false, true]) {
    for (const n of ROW_COUNTS) {
      const rows = makeRows(n);
      const times: number[] = [];
      for (let r = 0; r < RUNS; r++) times.push(rebuild(dir, rows, withFts));
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      console.log(
        `  ${withFts ? 'fts5-trigram' : 'no-fts      '} ${String(n).padStart(6)} rows: median ${median.toFixed(1)}ms (min ${times[0].toFixed(1)}, max ${times[times.length - 1].toFixed(1)})`,
      );
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
