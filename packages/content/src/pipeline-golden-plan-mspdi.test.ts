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
 * One edge, stated: a Project root that fails the full sniff (no-sniff.xml).
 * The old path gave the word itself, `{ kind: 'none', word: 'no-rows' }`, and
 * the write spot wrote it with `parsed: false`. The step answers `ok` with
 * no tabs, and the write spot gives the same word `no-rows` with
 * `parsed: true` (writeRowsOrWord, the `word` helper). `parsed` only says
 * whether the word replaces a database of these bytes, and bytes that fail
 * the sniff can never have had one. So the result is the same.
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
import { parsedFileOfRun, type ParsedFile } from './file-database';
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
  it('the fixed set is the nine made-up files', () => {
    expect(FIXTURES).toEqual([
      'empty-plan.xml',
      'large.xml',
      'malformed.xml',
      'no-sniff.xml',
      'normal.xml',
      'not-plan.xml',
      'odd-fields.xml',
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

  it('no-sniff.xml: the old word, and now ok with no tabs, which the write spot makes the same word', async () => {
    expect(golden('no-sniff.xml')).toEqual({ kind: 'none', word: 'no-rows' });
    expect(await readInProcess(fixture('no-sniff.xml'))).toEqual({ kind: 'sheets', sheets: [] });
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
