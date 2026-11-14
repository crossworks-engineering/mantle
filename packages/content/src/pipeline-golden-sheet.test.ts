/**
 * The golden compare of the move of `sheet` (docs/pipelines.md, "The
 * same-result proof of a move"). The golden files in
 * packages/files/src/pipelines/pkg/sheet/golden/ were written by the OLD path
 * (the adapter in file-database.ts: the parser's grid job for a workbook, the
 * brain's own read for a CSV) before the move, in their own commits. Here the
 * step runs in this process, its result is mapped as readSheets maps it, and
 * it must give the same golden text and the same stamp. A golden file is
 * never changed to make this pass.
 *
 * The edges, stated:
 * - The files the old path called unreadable (a legacy file that cannot be
 *   converted, a CSV with a stray quote, a legacy workbook under .csv, a date
 *   cell that is no date): the step throws, and the parser job fails with
 *   `failed`, which is a verdict at once, so parseFileSheets gives the same
 *   word `unreadable` on the first read (the end-to-end case in
 *   ./pipeline-runner.test.ts). Before, the CSV's word came from
 *   DelimitedReadError in this process; now it comes from the job.
 * - over-cap.csv: its word `too-large` is the core's early cap
 *   (parseFileSheets), not the step's, and it costs no parser job. With a
 *   Table wanted it is read: the step gives over-cap.csv.table.json.
 * - macro.xlsm: `.xlsm` is not in the reader's match list, so no upload
 *   reaches the reader with it, before or after. Its golden file is the old
 *   adapter's code on its bytes, and the step is given the extension `xlsm`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { builtinForExt, PIPELINE_API, pipelineStampOf } from '@mantle/files';
import { PIPELINE_PACKAGES } from '@mantle/files/pipelines/pkg';
import { inProcessStepJob } from '@mantle/files/pipelines/test-job';
import { parsedFileOfRun, parseFileSheets, type ParsedFile } from './file-database';
import { goldenOf } from './pipeline-golden';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'sheet');
const FIXTURES = readdirSync(path.join(PKG, 'fixtures'))
  .filter((n) => !n.startsWith('.'))
  .sort();
const SHEET = builtinForExt('xlsx')!;
const dir = mkdtempSync(path.join(os.tmpdir(), 'sheet-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1);
const fixture = (name: string) => readFileSync(path.join(PKG, 'fixtures', name));
const golden = (name: string) =>
  JSON.parse(readFileSync(path.join(PKG, 'golden', `${name}.json`), 'utf8')) as unknown;

/** The old path's verdicts on the document: the step throws for these. */
const UNREADABLE = ['bad-date.xlsx', 'broken.xls', 'stray-quote.csv', 'xls-bytes.csv'];

/** The step in this process, its result mapped as readSheets maps it. */
async function readInProcess(name: string): Promise<ParsedFile> {
  const bytes = fixture(name);
  const { step } = await PIPELINE_PACKAGES.sheet!();
  const result = await step(
    {
      api: PIPELINE_API,
      step: 1,
      options: {},
      file: { name, ext: extOf(name), size: bytes.length, sha256: 'x' },
    },
    inProcessStepJob(bytes, dir),
  );
  const write = result.calls?.find((c) => c.call === 'tool');
  return parsedFileOfRun(SHEET, {
    status: result.status,
    ...(write ? { write: write.input as never } : {}),
  });
}

describe('sheet: the step gives what the old path gave', () => {
  it('the fixed set is the twenty-two made-up files, and sheet is a package', () => {
    expect(FIXTURES).toEqual([
      'bad-date.xlsx',
      'bom.csv',
      'broken.xls',
      'comma.csv',
      'empty.csv',
      'header-only.csv',
      'large.xlsx',
      'legacy.xls',
      'macro.xlsm',
      'odd-numbers.csv',
      'odd-numbers.xlsx',
      'only-empty.xlsx',
      'over-cap.csv',
      'png-bytes.xlsx',
      'quoted.csv',
      'semicolon.csv',
      'sheets.xlsx',
      'stray-quote.csv',
      'tabs.csv',
      'typed.xlsx',
      'xls-bytes.csv',
      'zip-not-workbook.csv',
    ]);
    for (const ext of ['xlsx', 'xls', 'csv']) {
      expect(builtinForExt(ext)).toMatchObject({ id: 'sheet', runtime: 'bun', entry: 'step.ts' });
    }
    expect(builtinForExt('xlsm')).toBeNull();
    expect(SHEET.needs.timeMs).toBe(120_000);
  });

  for (const name of FIXTURES.filter((n) => !UNREADABLE.includes(n) && n !== 'over-cap.csv')) {
    it(`${name}: the same tabs, their order and names, columns, types and rows`, async () => {
      expect(JSON.parse(goldenOf(await readInProcess(name)))).toEqual(golden(name));
    });
  }

  for (const name of UNREADABLE) {
    it(`${name}: the old word was unreadable, and the step throws (a failed job)`, async () => {
      expect(golden(name)).toEqual({ kind: 'none', word: 'unreadable' });
      await expect(readInProcess(name)).rejects.toThrow();
    });
  }

  it('over-cap.csv: too-large by the core with no parser call; with a Table wanted, the old rows', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', '0.25');
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetch);
    expect(golden('over-cap.csv')).toEqual({ kind: 'none', word: 'too-large' });
    expect(await parseFileSheets(fixture('over-cap.csv'), 'csv')).toEqual(golden('over-cap.csv'));
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(goldenOf(await readInProcess('over-cap.csv')))).toEqual(
      golden('over-cap.csv.table'),
    );
  });

  it('the stamp is the same: the id and the version did not move', async () => {
    const parsed = await readInProcess('sheets.xlsx');
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    expect(
      pipelineStampOf(
        SHEET,
        parsed.sheets.map((s) => ({ name: s.name, columns: s.columns.map((c) => c.name) })),
      ),
    ).toEqual({
      pipeline_id: 'sheet',
      pipeline_version: '1.0.0',
      pipeline_api: '1',
      shapes: '',
    });
  });
});
