/**
 * The pure parts of `pipeline-compare` (./pipeline-compare.ts): a database's
 * tabs as the compare sees them, the kinds of difference, and the refusals
 * of the task before it reads anything. No Postgres; the databases are
 * scratch SQLite files written by the writer of a real build.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ensureWorkbookDoc } from '@mantle/content-core/table-model';
import { tabsOfSheets } from '@mantle/content/file-database';
import { writeFileDatabaseDoc } from '@mantle/content/table-broker';
import type { ParsedSheet } from '@mantle/files/sheet-to-grid';
import { BAD_LIMIT } from './dwg-reindex';
import { compareFile, differencesOf, runPipelineCompare, tabSumsOf } from './pipeline-compare';

// The file row, its bytes, its stamp and the read now, as compareFile sees
// them: no Postgres. The databases are real SQLite files.
const h = vi.hoisted(() => ({
  abs: '',
  bytes: Buffer.from('tag,size\nP-101,50\n'),
  stamp: null as unknown,
  after: null as unknown,
  parsed: null as unknown,
  ext: 'csv',
  afterSheets: [] as ParsedSheet[],
}));
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    fileDbSqlitePath: async () => h.abs,
    fileDataRow: async () => ({ id: 'f' }),
    fileDataRefusal: async () => null,
    fileDataExt: () => h.ext,
    readFileNodeBytes: async () => ({ bytes: h.bytes, filename: `a.${h.ext}` }),
  };
});
vi.mock('@mantle/content/file-database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/file-database')>();
  return {
    ...actual,
    readFileDbStamp: async () => h.stamp,
    readFileDbAfter: async () => h.after,
    parseFileSheets: async () => h.parsed,
    afterSheetsOf: () => ({ sheets: h.afterSheets }),
  };
});

const dir = mkdtempSync(path.join(os.tmpdir(), 'pipeline-compare-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sheet = (rows: (string | number | null)[][], name = 'Lines'): ParsedSheet => ({
  name,
  columns: [
    { name: 'Tag', type: 'text' },
    { name: 'Size', type: 'number' },
  ],
  rows,
});

function dbOf(sheets: ParsedSheet[]): string {
  const abs = path.join(dir, `${randomUUID()}.sqlite`);
  writeFileDatabaseDoc(abs, ensureWorkbookDoc({ tabs: tabsOfSheets(sheets) }), {
    fileId: randomUUID(),
    ownerId: randomUUID(),
  });
  return abs;
}

describe('pipeline-compare', () => {
  it('the same sheets give equal sums; each change is its own kind', () => {
    const base = [
      sheet([
        ['P-101', 50],
        ['P-102', 80],
      ]),
    ];
    const a = tabSumsOf(dbOf(base));
    expect(a).toEqual([
      {
        name: 'Lines',
        columns: ['Tag', 'Size'],
        rows: 2,
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(differencesOf(a, tabSumsOf(dbOf(base)))).toEqual([]);
    expect(differencesOf(a, tabSumsOf(dbOf([sheet([['P-101', 50]])])))).toEqual(['rows']);
    expect(
      differencesOf(
        a,
        tabSumsOf(
          dbOf([
            sheet([
              ['P-101', 50],
              ['P-102', 81],
            ]),
          ]),
        ),
      ),
    ).toEqual(['hash']);
    expect(differencesOf(a, tabSumsOf(dbOf([sheet([['P-101', 50]], 'Other')])))).toEqual(['tabs']);
    const wider: ParsedSheet = {
      ...base[0]!,
      columns: [...base[0]!.columns, { name: 'Note', type: 'text' }],
      rows: [
        ['P-101', 50, null],
        ['P-102', 80, null],
      ],
    };
    expect(differencesOf(a, tabSumsOf(dbOf([wider])))).toEqual(['columns']);
  });

  it('a clock column (CLOCK_COLUMNS) is null on both sides: only `Read ms` differs, equal', () => {
    // A PDF drawing's Pages tab, cut to three columns: two reads of the same
    // page differ in the time the read took.
    const pages = (status: string, ms: number): ParsedSheet => ({
      name: 'Pages',
      columns: [
        { name: 'Page', type: 'number' },
        { name: 'Status', type: 'text' },
        { name: 'Read ms', type: 'number' },
      ],
      rows: [[1, status, ms]],
    });
    const stored = tabSumsOf(dbOf([pages('read', 412)]));
    expect(stored[0]!.columns).toEqual(['Page', 'Status', 'Read ms']);
    expect(differencesOf(stored, tabSumsOf(dbOf([pages('read', 97)])))).toEqual([]);
    // A real difference in another column of Pages is still one.
    expect(differencesOf(stored, tabSumsOf(dbOf([pages('failed', 412)])))).toEqual(['hash']);
    // The same column in a tab of another name is no clock: it is compared.
    const other = (ms: number) => ({ ...pages('read', ms), name: 'Sheet1' });
    expect(differencesOf(tabSumsOf(dbOf([other(1)])), tabSumsOf(dbOf([other(2)])))).toEqual([
      'hash',
    ]);
  });

  it('a repeated header is read by the stored names: the same file is equal, every time', () => {
    // Two columns named Rating, of other values. Each write gives the
    // columns new random ids, so a read by display name would take one of
    // the two at random.
    const valves = (a: string, b: string): ParsedSheet => ({
      name: 'Valves',
      columns: [
        { name: 'Valve', type: 'text' },
        { name: 'Rating', type: 'text' },
        { name: 'Rating', type: 'text' },
      ],
      rows: [
        ['V-1', a, b],
        ['V-2', b, a],
      ],
    });
    for (let i = 0; i < 5; i += 1) {
      const stored = tabSumsOf(dbOf([valves('150#', '300#')]));
      expect(stored[0]!.columns).toEqual(['Valve', 'Rating', 'Rating']);
      expect(differencesOf(stored, tabSumsOf(dbOf([valves('150#', '300#')]))), `run ${i}`).toEqual(
        [],
      );
      // The two columns swapped is a difference.
      expect(differencesOf(stored, tabSumsOf(dbOf([valves('300#', '150#')]))), `run ${i}`).toEqual([
        'hash',
      ]);
    }
  });

  it('refuses before it reads anything: no pipeline, a bad id, a bad limit', async () => {
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    expect(await runPipelineCompare([], print)).toBe(2);
    expect(lines.pop()).toMatch(/--pipeline=<id> is needed/);
    expect(await runPipelineCompare(['--pipeline=sheet', '--file=nope'], print)).toBe(2);
    expect(lines.pop()).toMatch(/not an id/);
    expect(await runPipelineCompare(['--pipeline=sheet', '--limit=0'], print)).toBe(2);
    expect(lines.pop()).toContain(BAD_LIMIT);
  });

  it('a router is no id: --pipeline=pdf-router is refused with exit code 2, dry run and --apply', async () => {
    for (const argv of [['--pipeline=pdf-router'], ['--pipeline=pdf-router', '--apply']]) {
      const lines: string[] = [];
      const code = await runPipelineCompare(argv, (l) => lines.push(l));
      expect(code, argv.join(' ')).toBe(2);
      // One line, the usage, and nothing compared.
      expect(lines, argv.join(' ')).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^\[pipeline-compare\] --pipeline=<id> is needed, one of: .* Nothing done\.$/,
      );
      expect(lines[0]).not.toContain('pdf-router');
      expect(lines[0]).toContain('drawing-pdf');
      expect(lines[0]).toContain('site-tags');
    }
  });

  const rowOf = (ext: string) => ({
    id: randomUUID(),
    ownerId: randomUUID(),
    path: 'files',
    title: `a.${ext}`,
    data: { sha256: createHash('sha256').update(h.bytes).digest('hex') },
  });

  it("a reader database that also holds an after tab is equal: the after tab is not the reader's", async () => {
    const { builtinForExt, pipelineStampOf, AFTER_PIPELINES } = await import('@mantle/files');
    // A file type the after pipeline matches: its tab was patched in.
    h.ext = 'dxf';
    const cad = builtinForExt('dxf')!;
    const after = AFTER_PIPELINES[0]!;
    expect(after.match.ext).toContain('dxf');
    const lines = sheet([['P-101', 50]]);
    const siteTags = { ...sheet([['FIC-101', 1]]), name: after.produces.tabs![0]! };
    h.abs = dbOf([lines, siteTags]);
    h.stamp = pipelineStampOf(cad, [{ name: 'Lines', columns: ['Tag', 'Size'] }]);
    h.parsed = { kind: 'sheets', sheets: [lines] };
    const row = rowOf('dxf');
    const state = { options: {}, optionsHash: '' };
    expect(await compareFile(row as never, cad, state)).toEqual(['equal']);
    h.parsed = { kind: 'sheets', sheets: [sheet([['P-101', 51]])] };
    expect(await compareFile(row as never, cad, state)).toEqual(['different', 'different hash']);
  });

  it('a sheet named as an after tab, on a file type no after pipeline matches, is a normal tab', async () => {
    const { builtinForExt, pipelineStampOf, AFTER_PIPELINES } = await import('@mantle/files');
    h.ext = 'xlsx';
    const xlsx = builtinForExt('xlsx')!;
    const after = AFTER_PIPELINES[0]!;
    expect(after.match.ext).not.toContain('xlsx');
    const lines = sheet([['P-101', 50]]);
    // The person's own sheet, with the after tab's name.
    const own = { ...sheet([['FIC-101', 1]]), name: after.produces.tabs![0]! };
    h.abs = dbOf([lines, own]);
    h.stamp = pipelineStampOf(xlsx, [
      { name: 'Lines', columns: ['Tag', 'Size'] },
      { name: own.name, columns: ['Tag', 'Size'] },
    ]);
    h.parsed = { kind: 'sheets', sheets: [lines, own] };
    const row = rowOf('xlsx');
    const state = { options: {}, optionsHash: '' };
    expect(await compareFile(row as never, xlsx, state)).toEqual(['equal']);
    h.parsed = { kind: 'sheets', sheets: [lines, { ...own, rows: [['FIC-101', 2]] }] };
    expect(await compareFile(row as never, xlsx, state)).toEqual(['different', 'different hash']);
  });

  it('a current after entry is compared: the same rows are equal', async () => {
    const { AFTER_PIPELINES, withAfterEntry } = await import('@mantle/files');
    h.ext = 'dxf';
    const after = AFTER_PIPELINES[0]!;
    const tab = { ...sheet([['FIC-101', 1]]), name: after.produces.tabs![0]! };
    h.abs = dbOf([sheet([['P-101', 50]]), tab]);
    h.after = { pipelines_after: withAfterEntry(undefined, after, '') };
    h.afterSheets = [tab];
    const state = { options: {}, optionsHash: '' };
    expect(await compareFile(rowOf('dxf') as never, after, state)).toEqual(['equal']);
    h.afterSheets = [{ ...tab, rows: [['FIC-102', 1]] }];
    expect(await compareFile(rowOf('dxf') as never, after, state)).toEqual([
      'different',
      'different hash',
    ]);
  });

  it('an after tab written at an older version or with other options is not compared', async () => {
    const { AFTER_PIPELINES, withAfterEntry } = await import('@mantle/files');
    const after = AFTER_PIPELINES[0]!;
    h.abs = dbOf([{ ...sheet([['FIC-101', 1]]), name: after.produces.tabs![0]! }]);
    const row = {
      id: randomUUID(),
      ownerId: randomUUID(),
      path: 'files',
      title: 'a.dwg',
      data: { sha256: createHash('sha256').update(h.bytes).digest('hex') },
    };
    const state = { options: {}, optionsHash: '' };
    h.after = { pipelines_after: withAfterEntry(undefined, { ...after, version: '0.0.1' }, '') };
    expect(await compareFile(row as never, after, state)).toEqual(['not compared older']);
    h.after = { pipelines_after: withAfterEntry(undefined, after, 'abcd1234') };
    expect(await compareFile(row as never, after, state)).toEqual(['not compared older']);
  });
});
