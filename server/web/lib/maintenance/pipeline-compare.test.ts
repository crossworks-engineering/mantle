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
}));
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    fileDbSqlitePath: async () => h.abs,
    fileDataRow: async () => ({ id: 'f' }),
    fileDataRefusal: async () => null,
    fileDataExt: () => 'csv',
    readFileNodeBytes: async () => ({ bytes: h.bytes, filename: 'a.csv' }),
  };
});
vi.mock('@mantle/content/file-database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/file-database')>();
  return {
    ...actual,
    readFileDbStamp: async () => h.stamp,
    readFileDbAfter: async () => h.after,
    parseFileSheets: async () => h.parsed,
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

  it("a reader database that also holds an after tab is equal: the after tab is not the reader's", async () => {
    const { builtinForExt, pipelineStampOf, AFTER_PIPELINES } = await import('@mantle/files');
    const csv = builtinForExt('csv')!;
    const lines = sheet([['P-101', 50]]);
    const siteTags = { ...sheet([['FIC-101', 1]]), name: AFTER_PIPELINES[0]!.produces.tabs![0]! };
    h.abs = dbOf([lines, siteTags]);
    h.stamp = pipelineStampOf(csv, [{ name: 'Lines', columns: ['Tag', 'Size'] }]);
    h.parsed = { kind: 'sheets', sheets: [lines] };
    const row = {
      id: randomUUID(),
      ownerId: randomUUID(),
      path: 'files',
      title: 'a.csv',
      data: { sha256: createHash('sha256').update(h.bytes).digest('hex') },
    };
    const state = { options: {}, optionsHash: '' };
    expect(await compareFile(row as never, csv, state)).toEqual(['equal']);
    h.parsed = { kind: 'sheets', sheets: [sheet([['P-101', 51]])] };
    expect(await compareFile(row as never, csv, state)).toEqual(['different', 'different hash']);
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
