/**
 * A long read's rows to a file, never to memory (./sheet-spill.ts): the
 * fold gives the grid parseSheet gives, a row read back from the file is
 * typed as the row in hand, the limits cut where they say, and a long CSV or
 * workbook spilled and read back is the grid of the read in memory. Made-up
 * data only.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readSpreadsheetGrid, spillWorkbook, type SpillTo } from './sheet-grid';
import { streamWorkbookRows } from './sheet-read';
import { RowsSpill } from './sheet-spill';
import {
  GridFold,
  RowKeeper,
  gridRowOf,
  gridRowOfLine,
  parseDelimited,
  parseSheet,
  type ParsedSheet,
} from './sheet-to-grid';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'pipelines/pkg/sheet/fixtures',
);
const dir = mkdtempSync(path.join(os.tmpdir(), 'sheet-spill-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

let n = 0;
const spillTo = (maxRows = 1e9, maxBytes = 1e12, until = Date.now() + 60_000) => {
  const file = path.join(dir, `rows-${n++}`);
  const to: SpillTo & { file: string } = {
    file,
    open: () => new RowsSpill(file, maxRows, maxBytes, until),
    spilled: [],
  };
  return to;
};

/** The grids of a spilled read, its rows read back from its file. */
function readBack(tabs: ParsedSheet[], to: SpillTo & { file: string }): ParsedSheet[] {
  const lines = readFileSync(to.file, 'utf8').split('\n').filter(Boolean);
  const byTab = new Map<number, unknown[][]>();
  let at = -1;
  for (const line of lines) {
    const v = JSON.parse(line) as unknown;
    if (Array.isArray(v)) byTab.get(at)!.push(v);
    else byTab.set((at = (v as { tab: number }).tab), []);
  }
  return tabs.map((t, i) => {
    const s = to.spilled[i]!;
    const rows = byTab.get(s.tab) ?? [];
    expect(rows).toHaveLength(s.rows);
    return { ...t, rows: rows.map((r) => gridRowOfLine({ columns: t.columns, keep: s.keep }, r)) };
  });
}

describe('GridFold', () => {
  it('gives the grid parseSheet gives, a row at a time', () => {
    const d = new Date(Date.UTC(2026, 0, 2));
    const rows: unknown[][] = [
      [],
      [null, '  ', null],
      ['Tag', null, 'When', 'Flag', 'Mixed'],
      ['P-1', null, d, true, 1],
      [null, null, null, null, null],
      ['P-2', null, new Date(Date.UTC(2026, 0, 3)), false, 'x'],
      ['P-3', null, null, null, null, null, 'stray'],
    ];
    const fold = new GridFold();
    const body: unknown[][] = [];
    for (const r of rows) if (fold.add(r) === 'body') body.push(r);
    const shape = fold.shape()!;
    expect(shape.keep).toEqual([0, 2, 3, 4, 6]);
    expect(shape.columns).toEqual([
      { name: 'Tag', type: 'text' },
      { name: 'When', type: 'date' },
      { name: 'Flag', type: 'checkbox' },
      { name: 'Mixed', type: 'text' },
      { name: 'Column 7', type: 'text' },
    ]);
    expect(fold.rows).toBe(3);
    expect(parseSheet('S', rows)).toEqual([
      { name: 'S', columns: shape.columns, rows: body.map((r) => gridRowOf(shape, r)) },
    ]);
  });

  it('a row read back from its JSON line is typed as the row in hand', () => {
    const shape = {
      keep: [0, 1, 2, 3, 4],
      columns: [
        { name: 'D', type: 'date' as const },
        { name: 'T', type: 'datetime' as const },
        { name: 'N', type: 'number' as const },
        { name: 'B', type: 'checkbox' as const },
        { name: 'X', type: 'text' as const },
      ],
    };
    const rows: unknown[][] = [
      [new Date(Date.UTC(2026, 4, 1)), new Date(Date.UTC(2026, 4, 1, 13, 5)), '1,234.5', true, 7],
      [null, null, 12, false, new Date(Date.UTC(2020, 1, 2, 3, 4))],
      ['', ' ', null, null, 'text'],
    ];
    for (const r of rows) {
      expect(gridRowOfLine(shape, JSON.parse(JSON.stringify(r)))).toEqual(gridRowOf(shape, r));
    }
  });
});

describe('RowsSpill', () => {
  it('keeps rows to its row limit, then counts them: database_rows', () => {
    const to = spillTo(2);
    const s = to.open();
    s.startTab(0);
    for (let i = 0; i < 5; i++) s.take([i, `r${i}`]);
    s.close();
    expect(s.cut()).toEqual({ database_rows: { what: 'rows', read: 2, total: 5, limit: 2 } });
    expect(readFileSync(to.file, 'utf8')).toBe('{"tab":0}\n[0,"r0"]\n[1,"r1"]\n');
  });

  it('keeps rows to the room of its scratch space: database_size, the bytes written', () => {
    const to = spillTo(1e9, 40);
    const s = to.open();
    s.startTab(0);
    for (let i = 0; i < 10; i++) s.take(['abcdefgh']);
    s.close();
    expect(s.cut()).toEqual({ database_size: { what: 'rows', read: 2, total: 10, limit: 40 } });
    expect(readFileSync(to.file).length).toBeLessThanOrEqual(40);
  });

  it('keeps rows to its deadline: database_time, with no limit', () => {
    const to = spillTo(1e9, 1e12, Date.now() - 1);
    const s = to.open();
    s.startTab(0);
    s.atLeast = true;
    s.take(['late']);
    s.close();
    expect(s.cut()).toEqual({
      database_time: { what: 'rows', read: 0, total: 1, atLeast: true },
    });
  });
});

describe('a long read spilled and read back', () => {
  it('a CSV past the budget: its rows go to the file, and read back are the grid in memory', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', String(1 / 1024 / 1024));
    for (const name of ['comma.csv', 'quoted.csv', 'tabs.csv', 'typed.csv', 'bom.csv']) {
      if (!readdirSync(FIXTURES).includes(name)) continue;
      const bytes = readFileSync(path.join(FIXTURES, name));
      const to = spillTo();
      const tabs = await readSpreadsheetGrid(bytes, 'csv', undefined, to);
      expect(to.spill, name).toBeDefined();
      expect(
        tabs.every((t) => t.rows.length === 0),
        name,
      ).toBe(true);
      expect(readBack(tabs, to), name).toEqual(await parseDelimited(bytes));
    }
  });

  it('a CSV under the budget whose cells pass it in memory is spilled, never cut', async () => {
    // 2 bytes of text a row, counted 4 in memory: 0.6 MB of text, 1.2 MB kept.
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', '1');
    const bytes = Buffer.from('tag\n' + 'x\n'.repeat(300_000));
    const to = spillTo();
    const keep = new RowKeeper(1e9, 1024 * 1024);
    const tabs = await readSpreadsheetGrid(bytes, 'csv', keep, to);
    expect(to.spill).toBeDefined();
    expect(to.spill!.cut()).toBeNull();
    expect(to.spilled).toEqual([{ tab: 0, rows: 300_000, keep: [0] }]);
    expect(readBack(tabs, to)[0]!.rows).toHaveLength(300_000);
  });

  it('counting past a cut stops at the deadline: at least', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', String(1 / 1024 / 1024));
    const bytes = Buffer.from('tag\n' + 'x\n'.repeat(1000));
    const to = spillTo(5, 1e12, Date.now() - 1);
    await readSpreadsheetGrid(bytes, 'csv', undefined, to);
    const cut = to.spill!.cut()!;
    expect(cut.database_time ?? cut.database_rows).toMatchObject({ read: 0, atLeast: true });
    expect((cut.database_time ?? cut.database_rows)!.total).toBeLessThan(1000);
  });

  it('a CSV under the budget is read in memory, as before', async () => {
    const bytes = readFileSync(path.join(FIXTURES, 'comma.csv'));
    const to = spillTo();
    const tabs = await readSpreadsheetGrid(bytes, 'csv', undefined, to);
    expect(to.spill).toBeUndefined();
    expect(tabs).toEqual(await parseDelimited(bytes));
  });

  it('a CSV cut by its row limit: the head of the file, and every row counted', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', String(1 / 1024 / 1024));
    const csv = ['Tag,Reading', ...Array.from({ length: 50 }, (_, i) => `T-${i},${i}`)].join('\n');
    const to = spillTo(10);
    const tabs = await readSpreadsheetGrid(Buffer.from(csv), 'csv', undefined, to);
    expect(to.spill!.cut()).toEqual({
      database_rows: { what: 'rows', read: 10, total: 50, limit: 10 },
    });
    const back = readBack(tabs, to)[0]!;
    expect(back.rows).toHaveLength(10);
    expect(back.rows[0]).toEqual(['T-0', 0]);
    expect(back.columns).toEqual([
      { name: 'Tag', type: 'text' },
      { name: 'Reading', type: 'number' },
    ]);
  });

  it('every workbook fixture through the stream: read back, the grid of the stream read in memory', async () => {
    for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith('.xlsx'))) {
      const bytes = readFileSync(path.join(FIXTURES, name));
      // The stream read in memory: the sheets in zip order, parseSheet each.
      const sheets = new Map<number, { name: string; rows: unknown[][] }>();
      let readable = true;
      await streamWorkbookRows(bytes, (sheet, cells, no) => {
        if (!sheets.has(no)) sheets.set(no, { name: sheet, rows: [] });
        sheets.get(no)!.rows.push(cells);
        return true;
      }).catch(() => (readable = false));
      if (!readable) continue;
      // A workbook the read in memory refuses (a date it cannot read) is
      // the unreadable word on both paths' callers: not compared here.
      let inMemory: ParsedSheet[];
      try {
        inMemory = [...sheets.values()].flatMap((s) => parseSheet(s.name, s.rows));
      } catch {
        continue;
      }
      const to = spillTo();
      const tabs = await spillWorkbook(bytes, to);
      expect(readBack(tabs, to), name).toEqual(inMemory);
    }
  });
});
