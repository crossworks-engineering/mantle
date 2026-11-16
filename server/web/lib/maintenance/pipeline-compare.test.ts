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
import {
  compareFile,
  differencesAt,
  differencesOf,
  namesArePrintable,
  runCompare,
  runPipelineCompare,
  tabSumsOf,
  Where,
} from './pipeline-compare';
import { pipelinesOf as registryOf } from '@mantle/content/pipeline-registry';
/** The box's pipelines (the registry): the built-ins. */
const pipelines = registryOf([]);
const pipelinesOf = async () => pipelines;

// The file row, its bytes, its stamp and the read now, as compareFile sees
// them: no Postgres. The databases are real SQLite files.
const h = vi.hoisted(() => ({
  abs: '',
  bytes: Buffer.from('tag,size\nP-101,50\n'),
  stamp: null as unknown,
  /** A stamp by file id, over `stamp`. */
  stamps: new Map<string, unknown>(),
  /** The options of each read now, in order: a PDF's carry pdfStored. */
  parses: [] as Record<string, unknown>[],
  page: [] as unknown[],
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
    readFileDbStamp: async (id: string) => (h.stamps.has(id) ? h.stamps.get(id) : h.stamp),
    readFileDbAfter: async () => h.after,
    parseFileSheets: async (_bytes: unknown, _ext: unknown, opts: Record<string, unknown>) => {
      h.parses.push(opts);
      return h.parsed;
    },
    afterSheetsOf: () => ({ sheets: h.afterSheets }),
  };
});

// The options of a pipeline on a box: none, so the hash is '' (no Postgres).
vi.mock('@mantle/content/pipeline-state', () => ({
  pipelineStateOf: async () => ({ options: {}, optionsHash: '' }),
}));

vi.mock('./pipeline-reread', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pipeline-reread')>();
  return { ...actual, candidatePage: async () => h.page };
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
        columnHashes: [expect.any(String), expect.any(String)],
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

  it('a difference says its tab and, for a hash, its columns', () => {
    const a = tabSumsOf(dbOf([sheet([['P-101', 50]]), sheet([['P-1', 1]], 'Texts')]));
    const b = tabSumsOf(dbOf([sheet([['P-101', 51]]), sheet([['P-1', 1]], 'Texts')]));
    expect(differencesAt(a, b)).toEqual([
      { kind: 'hash', tab: { name: 'Lines', index: 0 }, columns: [{ name: 'Size', index: 1 }] },
    ]);
    expect(differencesAt(a, a)).toEqual([]);
    // A tab on one side only names that tab and its side.
    const c = tabSumsOf(dbOf([sheet([['P-101', 50]])]));
    expect(differencesAt(a, c)).toEqual([
      { kind: 'tabs', tab: { name: 'Texts', index: 1, side: 'stored' }, columns: [] },
    ]);
    // The same tabs in another order name no tab.
    expect(differencesAt(a, [...a].reverse())).toEqual([{ kind: 'tabs', tab: null, columns: [] }]);
  });

  it('the names of a built-in drawing pipeline are printed; a spreadsheet or own pipeline gets places only', async () => {
    const { BUILTIN_PIPELINES } = await import('@mantle/files');
    for (const p of BUILTIN_PIPELINES) expect(namesArePrintable(p), p.id).toBe(p.id !== 'sheet');
    expect(namesArePrintable({ id: 'own-reader' })).toBe(false);
    const a = tabSumsOf(dbOf([sheet([['P-1', 1]], 'Texts'), sheet([['P-101', 50]], 'Symbols')]));
    const b = tabSumsOf(dbOf([sheet([['P-1', 1]], 'Texts'), sheet([['P-101', 51]], 'Symbols')]));
    const wider = tabSumsOf(
      dbOf([
        {
          ...sheet([['P-1', 1]], 'Texts'),
          columns: [...sheet([]).columns, { name: 'Note', type: 'text' }],
          rows: [['P-1', 1, null]],
        },
        sheet([['P-101', 50]], 'Symbols'),
      ]),
    );
    const ours = new Where();
    const theirs = new Where();
    for (let i = 0; i < 2; i += 1) {
      ours.addFile(differencesAt(a, b), true);
      theirs.addFile(differencesAt(a, b), false);
    }
    ours.addFile(differencesAt(a, wider), true);
    theirs.addFile(differencesAt(a, wider), false);
    expect(ours.text).toBe('Symbols 2 (hash: Size 2), Texts 1 (columns 1)');
    expect(theirs.text).toBe('tab 2 2 (hash: column 2 2), tab 1 1 (columns 1)');
    expect(theirs.text).not.toMatch(/Symbols|Texts|Size/);
  });

  it('a run with a difference ends with where it is, counts only', async () => {
    const { readerFor, BUILTIN_PIPELINES, pipelineStampOf } = await import('@mantle/files');
    h.ext = 'dxf';
    h.stamps.clear();
    const cad = readerFor(BUILTIN_PIPELINES, 'dxf')!;
    const symbols = sheet([['P-101', 50]], 'Symbols');
    h.abs = dbOf([symbols]);
    h.stamp = pipelineStampOf(cad, [{ name: 'Symbols', columns: ['Tag', 'Size'] }]);
    h.parsed = { kind: 'sheets', sheets: [sheet([['P-101', 51]], 'Symbols')] };
    h.page = [rowOf('dxf'), rowOf('dxf')];
    const { where, counts } = await runCompare(
      { pipeline: cad, pipelines, scope: {}, limit: 100, apply: true },
      () => {},
    );
    h.page = [];
    expect(counts.text).toBe('2 different, 2 different hash');
    expect(where.text).toBe('Symbols 2 (hash: Size 2)');
  });

  it('refuses before it reads anything: no pipeline, a bad id, a bad limit', async () => {
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    expect(await runPipelineCompare([], print, pipelinesOf)).toBe(2);
    expect(lines.pop()).toMatch(/--pipeline=<id> is needed/);
    expect(await runPipelineCompare(['--pipeline=sheet', '--file=nope'], print, pipelinesOf)).toBe(
      2,
    );
    expect(lines.pop()).toMatch(/not an id/);
    expect(await runPipelineCompare(['--pipeline=sheet', '--limit=0'], print, pipelinesOf)).toBe(2);
    expect(lines.pop()).toContain(BAD_LIMIT);
  });

  it('a router is no id: --pipeline=pdf-router is refused with exit code 2, dry run and --apply', async () => {
    for (const argv of [['--pipeline=pdf-router'], ['--pipeline=pdf-router', '--apply']]) {
      const lines: string[] = [];
      const code = await runPipelineCompare(argv, (l) => lines.push(l), pipelinesOf);
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
    const { readerFor, BUILTIN_PIPELINES, pipelineStampOf } = await import('@mantle/files');
    // A file type the after pipeline matches: its tab was patched in.
    h.ext = 'dxf';
    const cad = readerFor(BUILTIN_PIPELINES, 'dxf')!;
    const after = BUILTIN_PIPELINES.find((p) => p.id === 'site-tags')!;
    expect(after.match.ext).toContain('dxf');
    const lines = sheet([['P-101', 50]]);
    const siteTags = { ...sheet([['FIC-101', 1]]), name: after.produces.tabs![0]! };
    h.abs = dbOf([lines, siteTags]);
    h.stamp = pipelineStampOf(cad, [{ name: 'Lines', columns: ['Tag', 'Size'] }]);
    h.parsed = { kind: 'sheets', sheets: [lines] };
    const row = rowOf('dxf');
    const state = { options: {}, optionsHash: '' };
    expect(await compareFile(row as never, cad, state, pipelines)).toEqual(['equal']);
    h.parsed = { kind: 'sheets', sheets: [sheet([['P-101', 51]])] };
    expect(await compareFile(row as never, cad, state, pipelines)).toEqual([
      'different',
      'different hash',
    ]);
  });

  it('a sheet named as an after tab, on a file type no after pipeline matches, is a normal tab', async () => {
    const { readerFor, BUILTIN_PIPELINES, pipelineStampOf } = await import('@mantle/files');
    h.ext = 'xlsx';
    const xlsx = readerFor(BUILTIN_PIPELINES, 'xlsx')!;
    const after = BUILTIN_PIPELINES.find((p) => p.id === 'site-tags')!;
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
    expect(await compareFile(row as never, xlsx, state, pipelines)).toEqual(['equal']);
    h.parsed = { kind: 'sheets', sheets: [lines, { ...own, rows: [['FIC-101', 2]] }] };
    expect(await compareFile(row as never, xlsx, state, pipelines)).toEqual([
      'different',
      'different hash',
    ]);
  });

  it('a current after entry is compared: the same rows are equal', async () => {
    const { BUILTIN_PIPELINES, withAfterEntry } = await import('@mantle/files');
    h.ext = 'dxf';
    const after = BUILTIN_PIPELINES.find((p) => p.id === 'site-tags')!;
    const tab = { ...sheet([['FIC-101', 1]]), name: after.produces.tabs![0]! };
    h.abs = dbOf([sheet([['P-101', 50]]), tab]);
    h.after = { pipelines_after: withAfterEntry(undefined, after, '') };
    h.afterSheets = [tab];
    const state = { options: {}, optionsHash: '' };
    expect(await compareFile(rowOf('dxf') as never, after, state, pipelines)).toEqual(['equal']);
    h.afterSheets = [{ ...tab, rows: [['FIC-102', 1]] }];
    expect(await compareFile(rowOf('dxf') as never, after, state, pipelines)).toEqual([
      'different',
      'different hash',
    ]);
  });

  it('an after tab written at an older version or with other options is not compared', async () => {
    const { BUILTIN_PIPELINES, withAfterEntry } = await import('@mantle/files');
    const after = BUILTIN_PIPELINES.find((p) => p.id === 'site-tags')!;
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
    expect(await compareFile(row as never, after, state, pipelines)).toEqual([
      'not compared older',
    ]);
    h.after = { pipelines_after: withAfterEntry(undefined, after, 'abcd1234') };
    expect(await compareFile(row as never, after, state, pipelines)).toEqual([
      'not compared older',
    ]);
  });

  describe('--older: the databases before stamps', () => {
    const state = { options: {}, optionsHash: '' };
    const csvReader = async () => {
      const { readerFor, BUILTIN_PIPELINES } = await import('@mantle/files');
      h.ext = 'csv';
      h.stamps.clear();
      return readerFor(BUILTIN_PIPELINES, 'csv')!;
    };

    it('without the switch a database with no stamp is older, as before', async () => {
      const csv = await csvReader();
      const lines = sheet([['P-101', 50]]);
      h.abs = dbOf([lines]);
      h.stamp = null;
      h.parsed = { kind: 'sheets', sheets: [lines] };
      expect(await compareFile(rowOf('csv') as never, csv, state, pipelines)).toEqual([
        'not compared older',
      ]);
    });

    it('with it, an equal one and a different one are counted in their own words', async () => {
      const csv = await csvReader();
      const lines = sheet([['P-101', 50]]);
      h.abs = dbOf([lines]);
      h.stamp = null;
      h.parsed = { kind: 'sheets', sheets: [lines] };
      expect(await compareFile(rowOf('csv') as never, csv, state, pipelines, true)).toEqual([
        'equal (before stamps)',
      ]);
      h.parsed = { kind: 'sheets', sheets: [sheet([['P-101', 51]])] };
      expect(await compareFile(rowOf('csv') as never, csv, state, pipelines, true)).toEqual([
        'different (before stamps)',
        'different (before stamps) hash',
      ]);
      h.parsed = { kind: 'sheets', sheets: [lines, sheet([['P-1', 1]], 'Other')] };
      expect(await compareFile(rowOf('csv') as never, csv, state, pipelines, true)).toEqual([
        'different (before stamps)',
        'different (before stamps) tabs',
      ]);
      // A current stamp keeps today's words with the switch on.
      const { pipelineStampOf } = await import('@mantle/files');
      h.stamp = pipelineStampOf(csv, [{ name: 'Lines', columns: ['Tag', 'Size'] }]);
      h.parsed = { kind: 'sheets', sheets: [lines] };
      expect(await compareFile(rowOf('csv') as never, csv, state, pipelines, true)).toEqual([
        'equal',
      ]);
    });

    it('a stamp of an older version, of other options or of another pipeline stays older', async () => {
      const csv = await csvReader();
      const { pipelineStampOf } = await import('@mantle/files');
      const lines = sheet([['P-101', 50]]);
      h.abs = dbOf([lines]);
      h.parsed = { kind: 'sheets', sheets: [lines] };
      const tabs = [{ name: 'Lines', columns: ['Tag', 'Size'] }];
      for (const stamp of [
        pipelineStampOf({ ...csv, version: '0.0.1' }, tabs),
        { ...pipelineStampOf(csv, tabs), pipeline_options: 'abcd1234' },
        pipelineStampOf({ ...csv, id: 'made-up-reader' }, tabs),
      ]) {
        h.stamp = stamp;
        expect(await compareFile(rowOf('csv') as never, csv, state, pipelines, true)).toEqual([
          'not compared older',
        ]);
      }
    });

    it('the dry run counts the databases before stamps in their own words, with the switch only', async () => {
      const csv = await csvReader();
      const { pipelineStampOf } = await import('@mantle/files');
      h.abs = dbOf([sheet([['P-101', 50]])]);
      const rows = [rowOf('csv'), rowOf('csv'), rowOf('csv')];
      h.page = rows;
      h.stamp = null;
      h.stamps.set(
        rows[0]!.id,
        pipelineStampOf(csv, [{ name: 'Lines', columns: ['Tag', 'Size'] }]),
      );
      const run = (older: boolean) =>
        runCompare(
          { pipeline: csv, pipelines, scope: {}, limit: 100, apply: false, older },
          () => {},
        );
      expect((await run(false)).counts.text).toBe('3 to compare');
      expect((await run(true)).counts.text).toBe('1 to compare, 2 to compare (before stamps)');
      h.page = [];
    });

    it('a PDF before stamps: with a stored kind it gets it back; with none it is not compared and nothing is read', async () => {
      const { readerFor, BUILTIN_PIPELINES } = await import('@mantle/files');
      h.ext = 'pdf';
      h.stamps.clear();
      h.stamp = null;
      const pdf = readerFor(BUILTIN_PIPELINES, 'pdf', 'pid')!;
      expect(pdf.id).toBe('drawing-pdf');
      const texts = sheet([['P-101', 50]], 'Texts');
      // No File tab: no stored kind.
      h.abs = dbOf([texts]);
      h.parses = [];
      h.parsed = { kind: 'sheets', sheets: [texts] };
      expect(await compareFile(rowOf('pdf') as never, pdf, state, pipelines, true)).toEqual([
        'not compared no-stored-kind',
      ]);
      expect(h.parses).toEqual([]);
      // A File tab as v0.603 wrote it: the kind and the decider's answer.
      const file: ParsedSheet = {
        name: 'File',
        columns: [
          { name: 'Kind', type: 'text' },
          { name: 'Kind source', type: 'text' },
          { name: 'Rules kind', type: 'text' },
          { name: 'Decider answer', type: 'text' },
          { name: 'Decider confidence', type: 'number' },
          { name: 'Decider mode', type: 'text' },
          { name: 'Decider model', type: 'text' },
          { name: 'Vision read', type: 'checkbox' },
        ],
        rows: [['pid', 'decider', 'unsure', 'pid', 0.9, 'live', 'made-up-model', false]],
      };
      h.abs = dbOf([file, texts]);
      h.parsed = { kind: 'sheets', sheets: [file, texts] };
      expect(await compareFile(rowOf('pdf') as never, pdf, state, pipelines, true)).toEqual([
        'equal (before stamps)',
      ]);
      expect(h.parses).toHaveLength(1);
      expect(h.parses[0]!.pdfStored).toEqual({
        kind: 'pid',
        decision: {
          kind: 'pid',
          confidence: 0.9,
          model: 'made-up-model',
          mode: 'live',
          used: true,
        },
      });
      // A sketch read stays not compared.
      h.abs = dbOf([{ ...file, rows: [[...file.rows[0]!.slice(0, 7), true]] }, texts]);
      expect(await compareFile(rowOf('pdf') as never, pdf, state, pipelines, true)).toEqual([
        'not compared sketch-read',
      ]);
      expect(h.parses).toHaveLength(1);
    });
  });
});
