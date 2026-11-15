/**
 * The golden compare of the move of `plot-dwf` (docs/pipelines.md, "The
 * same-result proof of a move"). The golden files in
 * packages/files/src/pipelines/pkg/plot-dwf/golden/ were written by the OLD
 * path (the adapter in file-database.ts and the parser's grid job) before the
 * move, in their own commits. Here the step runs in this process, its result
 * is mapped as readSheets maps it, and it must give the same golden text,
 * the same stamp, the same text for search and the same number of sheet
 * pictures. A golden file is never changed to make this pass.
 *
 * No stored shape changed. A file that is not a DWF by its magic, and a DWF
 * with no sheets, gave `{ kind: 'sheets', sheets: [] }` on the old path (the
 * grid job gave no sheets) and give the same now (the step answers `ok` with
 * no tabs). A damaged DWF made the old grid job fail; the step throws, so
 * the new job fails the same way, and parseFileSheets gives the same word
 * `unreadable` (the case through a real parser is in pipeline-runner.test.ts).
 *
 * One edge, stated: the old adapter sent every `.dwf` to the parser, a file
 * that is not a DWF too (the grid job checked the magic). So a not-a-DWF file
 * cost one parser job before and costs one now, the pipelineRun job.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readerFor, BUILTIN_PIPELINES, PIPELINE_API, pipelineStampOf } from '@mantle/files';
import { PIPELINE_PACKAGES } from '@mantle/files/pipelines/pkg';
import { inProcessStepJob } from '@mantle/files/pipelines/test-job';
import { readDocumentText } from '@mantle/files/readers/document';
import { readEmbeddedImages } from '@mantle/files/readers/images';
import { parsedFileOfRun, type ParsedFile } from './file-database';
import { goldenOf } from './pipeline-golden';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'plot-dwf');
const FIXTURES = readdirSync(path.join(PKG, 'fixtures'))
  .filter((n) => n.endsWith('.dwf'))
  .sort();
const DWF = readerFor(BUILTIN_PIPELINES, 'dwf')!;
const dir = mkdtempSync(path.join(os.tmpdir(), 'plot-dwf-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (name: string) => readFileSync(path.join(PKG, 'fixtures', name));
const golden = (name: string) =>
  JSON.parse(readFileSync(path.join(PKG, 'golden', name), 'utf8')) as Record<string, unknown>;
/** The one fixture the old path could not open: its golden files are the
 *  failure, not a read. */
const DAMAGED = 'damaged.dwf';

/** The step in this process, its result mapped as readSheets maps it. */
async function readInProcess(bytes: Buffer): Promise<ParsedFile> {
  const { step } = await PIPELINE_PACKAGES['plot-dwf']!();
  const result = await step(
    { api: PIPELINE_API, step: 1, options: {} },
    inProcessStepJob(bytes, dir),
  );
  const write = result.calls?.find((c) => c.call === 'tool');
  return parsedFileOfRun(DWF, {
    status: result.status,
    ...(write ? { write: write.input as never } : {}),
  });
}

describe('plot-dwf: the step gives what the old path gave', () => {
  it('the fixed set is the eight made-up files', () => {
    expect(FIXTURES).toEqual([
      'damaged.dwf',
      'large.dwf',
      'no-labels.dwf',
      'no-sheets.dwf',
      'not-dwf.dwf',
      'odd-values.dwf',
      'plot-set.dwf',
      'single-sheet.dwf',
    ]);
    expect(DWF).toMatchObject({ id: 'plot-dwf', runtime: 'bun', entry: 'step.ts' });
    expect(DWF.needs).toEqual({ weight: 'heavy', timeMs: 120_000 });
  });

  for (const name of FIXTURES.filter((n) => n !== DAMAGED)) {
    it(`${name}: the same tabs, columns, rows and description`, async () => {
      const parsed = await readInProcess(fixture(name));
      expect(JSON.parse(goldenOf(parsed))).toEqual(golden(`${name}.json`));
    });
  }

  it('damaged.dwf: the old path could not read it, and the step throws, so the job fails as before', async () => {
    expect(golden(`${DAMAGED}.json`)).toEqual({ kind: 'none', word: 'unreadable' });
    await expect(readInProcess(fixture(DAMAGED))).rejects.toThrow(/no readable ZIP archive/);
  });

  it('the stamp is the same: the id and the version did not move', async () => {
    const parsed = await readInProcess(fixture('plot-set.dwf'));
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    expect(
      pipelineStampOf(
        DWF,
        parsed.sheets.map((s) => ({ name: s.name, columns: s.columns.map((c) => c.name) })),
      ),
    ).toEqual({
      pipeline_id: 'plot-dwf',
      pipeline_version: '1.0.0',
      pipeline_api: '1',
      shapes: '',
    });
  });

  for (const name of FIXTURES.filter((n) => n !== DAMAGED)) {
    it(`${name}: the text for search is the same string, and the same number of sheet pictures`, async () => {
      const bytes = fixture(name);
      const text = await readDocumentText(bytes, 'dwf');
      expect({
        sha256: createHash('sha256').update(text).digest('hex'),
        length: text.length,
      }).toEqual(golden(`${name}.text.json`));
      // The images job runs this read with a renderer; with none (or a
      // renderer that fails, as on a box with no CAD tier) the thumbnails.
      const { images } = await readEmbeddedImages(bytes, 'dwf');
      expect({ pictures: images.length }).toEqual(golden(`${name}.pictures.json`));
    });
  }

  it('damaged.dwf: the text and the pictures fail as before', async () => {
    expect(golden(`${DAMAGED}.text.json`)).toEqual({
      throws: { code: 'failed', retryable: false },
    });
    expect(golden(`${DAMAGED}.pictures.json`)).toEqual({
      throws: { code: 'failed', retryable: false },
    });
    await expect(readDocumentText(fixture(DAMAGED), 'dwf')).rejects.toThrow(/no readable ZIP/);
    await expect(readEmbeddedImages(fixture(DAMAGED), 'dwf')).rejects.toThrow(/no readable ZIP/);
  });
});
