/**
 * The golden compare of the move of `plan-mspdi` (docs/pipelines.md, "The
 * same-result proof of a move"). The golden files in
 * packages/files/src/pipelines/pkg/plan-mspdi/golden/ were written by the OLD
 * path (the adapter in file-database.ts and the parser's grid job) before the
 * move, in their own commit. Here the step runs in this process, its result
 * is mapped as readSheets maps it, and it must give the same golden text,
 * the same stamp, and the same text for search. A golden file is never
 * changed to make this pass.
 *
 * One edge, stated: a Project root that fails the full sniff (no-sniff.xml),
 * and a root that is not Project (not-plan.xml). On every caller the core
 * answers both before any job, as the old adapter did (parseFileSheets, the
 * plan check on the bytes in hand): `{ kind: 'none', word: 'no-rows' }` and
 * `{ kind: 'not-plan' }`, the golden files exactly (pipeline-runner.test.ts
 * pins that through a real parser, with no job). The step is reached with
 * such bytes only when it is run directly (this test): it answers
 * `not_mine` for another root, and `ok` with no tabs for a failed full
 * sniff, which the write spot would make the same word `no-rows`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinForExt, PIPELINE_API, pipelineStampOf } from '@mantle/files';
import { PIPELINE_PACKAGES } from '@mantle/files/pipelines/pkg';
import { inProcessStepJob } from '@mantle/files/pipelines/test-job';
import { readDocumentText } from '@mantle/files/readers/document';
import { parsedFileOfRun, parseFileSheets, type ParsedFile } from './file-database';
import { goldenOf } from './pipeline-golden';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'plan-mspdi');
const FIXTURES = readdirSync(path.join(PKG, 'fixtures'))
  .filter((n) => n.endsWith('.xml'))
  .sort();
const PLAN = builtinForExt('xml')!;
const dir = mkdtempSync(path.join(os.tmpdir(), 'plan-mspdi-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (name: string) => readFileSync(path.join(PKG, 'fixtures', name));
const golden = (name: string) =>
  JSON.parse(readFileSync(path.join(PKG, 'golden', `${name}.json`), 'utf8')) as unknown;

/** The cells of odd-number.xml that matter: the rows of Tasks, and its
 *  hours and work. The second task's duration rounds to a number that is
 *  not finite, so the old path's JSON made it null. */
function oddCells(g: unknown): { rows: number; hours: unknown[]; work: unknown[] } {
  const tasks = (
    g as { sheets: { name: string; columns: { name: string }[]; rows: unknown[][] }[] }
  ).sheets[0]!;
  const col = (n: string) => tasks.columns.findIndex((c) => c.name === n);
  return {
    rows: tasks.rows.length,
    hours: tasks.rows.map((r) => r[col('Duration (hours)')]),
    work: tasks.rows.map((r) => r[col('Work (hours)')]),
  };
}

/** The step in this process, its result mapped as readSheets maps it. */
async function readInProcess(bytes: Buffer): Promise<ParsedFile> {
  const { step } = await PIPELINE_PACKAGES['plan-mspdi']!();
  const result = await step(
    { api: PIPELINE_API, step: 1, options: {} },
    inProcessStepJob(bytes, dir),
  );
  const write = result.calls?.find((c) => c.call === 'tool');
  return parsedFileOfRun(PLAN, {
    status: result.status,
    ...(write ? { write: write.input as never } : {}),
  });
}

describe('plan-mspdi: the step gives what the old path gave', () => {
  it('the fixed set is the ten made-up files', () => {
    expect(FIXTURES).toEqual([
      'empty-plan.xml',
      'large.xml',
      'malformed.xml',
      'no-sniff.xml',
      'normal.xml',
      'not-plan.xml',
      'odd-fields.xml',
      'odd-number.xml',
      'outline.xml',
      'traps.xml',
    ]);
    expect(PLAN).toMatchObject({ id: 'plan-mspdi', runtime: 'bun', entry: 'step.ts' });
  });

  for (const name of FIXTURES.filter((n) => n !== 'no-sniff.xml')) {
    it(`${name}: the same tabs, columns, rows and description`, async () => {
      const parsed = await readInProcess(fixture(name));
      expect(JSON.parse(goldenOf(parsed))).toEqual(golden(name));
    });
  }

  it('no-sniff.xml run directly: ok with no tabs, which the write spot makes the old word', async () => {
    expect(golden('no-sniff.xml')).toEqual({ kind: 'none', word: 'no-rows' });
    expect(await readInProcess(fixture('no-sniff.xml'))).toEqual({ kind: 'sheets', sheets: [] });
  });

  it('no-sniff.xml and not-plan.xml through parseFileSheets: the golden files, with no job', async () => {
    // No parser runs in this test: an answer here is the core's, before any job.
    for (const name of ['no-sniff.xml', 'not-plan.xml']) {
      expect(JSON.parse(goldenOf(await parseFileSheets(fixture(name), 'xml'))), name).toEqual(
        golden(name),
      );
    }
  });

  it('odd-number.xml: the plan keeps its rows, with null where a number is not finite', async () => {
    const parsed = await readInProcess(fixture('odd-number.xml'));
    expect(JSON.parse(goldenOf(parsed))).toEqual(golden('odd-number.xml'));
    expect(oddCells(golden('odd-number.xml'))).toEqual({ rows: 2, hours: [8, null], work: [8, 4] });
  });

  it('the stamp is the same: the id and the version did not move', async () => {
    const parsed = await readInProcess(fixture('traps.xml'));
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    expect(
      pipelineStampOf(
        PLAN,
        parsed.sheets.map((s) => ({ name: s.name, columns: s.columns.map((c) => c.name) })),
      ),
    ).toEqual({
      pipeline_id: 'plan-mspdi',
      pipeline_version: '1.0.0',
      pipeline_api: '1',
      shapes: '',
    });
  });

  for (const name of FIXTURES) {
    it(`${name}: the text for search is the same string`, async () => {
      const text = await readDocumentText(fixture(name), 'xml');
      const want = JSON.parse(
        readFileSync(path.join(PKG, 'golden', `${name}.text.json`), 'utf8'),
      ) as { sha256: string; length: number };
      expect({
        sha256: createHash('sha256').update(text).digest('hex'),
        length: text.length,
      }).toEqual(want);
    });
  }
});
