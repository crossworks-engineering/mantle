/**
 * The golden compare, as a move runs it (./pipeline-golden.ts), on the
 * test-only package: the step in this process, the result mapped as
 * readSheets maps it, the golden file of the fixture, and the stamp. A move
 * copies this test into its package folder with its own fixtures.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PIPELINE_API, pipelineStampOf, tabHeadLine, tabRowLine } from '@mantle/files';
import { TEST_PACKAGES, TEST_PIPELINES } from '@mantle/files/pipelines/pkg-test';
import { inProcessStepJob } from '@mantle/files/pipelines/test-job';
import { parsedFileOfRun } from './file-database';
import { canonicalJson, goldenOf, GOLDEN_INLINE_MAX_BYTES } from './pipeline-golden';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'test-echo');
const ECHO = TEST_PIPELINES[0]!;
const dir = mkdtempSync(path.join(os.tmpdir(), 'pipeline-golden-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function runInProcess(body: Buffer, options: Record<string, unknown> = {}) {
  const { step } = await TEST_PACKAGES['test-echo']!();
  const result = await step({ api: PIPELINE_API, step: 1, options }, inProcessStepJob(body, dir));
  const write = result.calls?.find((c) => c.call === 'tool');
  return parsedFileOfRun(ECHO, {
    status: result.status,
    ...(write ? { write: write.input as never } : {}),
  });
}

describe('the golden compare', () => {
  it('the fixture gives its golden file, and the stamp the tabs promise', async () => {
    const fixture = readFileSync(path.join(PKG, 'fixtures', 'lines.echo'));
    const parsed = await runInProcess(fixture);
    const golden = readFileSync(path.join(PKG, 'golden', 'lines.echo.json'), 'utf8');
    expect(JSON.parse(goldenOf(parsed))).toEqual(JSON.parse(golden));
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    expect(
      pipelineStampOf(
        ECHO,
        parsed.sheets.map((s) => ({ name: s.name, columns: s.columns.map((c) => c.name) })),
      ),
    ).toEqual({
      pipeline_id: 'test-echo',
      pipeline_version: '1.0.0',
      pipeline_api: '1',
      shapes: '',
    });
  });

  it("not_mine maps to the reader's answer with no name", async () => {
    expect(await runInProcess(Buffer.from('x'), { mode: 'not_mine' })).toEqual({
      kind: 'not-plan',
    });
    expect(parsedFileOfRun({ match: { ext: ['pdf'] } }, { status: 'not_mine' })).toEqual({
      kind: 'not-drawing',
    });
  });

  it('an after body runs in process too', async () => {
    const body = Buffer.from(
      tabHeadLine('Texts', ['Text', 'Page', 'Layer', 'X', 'Y']) +
        tabRowLine(['FIC-101', 1, 'T', 1, 2]),
    );
    const parsed = await runInProcess(body, { mode: 'after' });
    expect(parsed.kind === 'sheets' && parsed.sheets[0]?.rows).toEqual([['FIC-101', 1, 'T', 1, 2]]);
  });

  it('canonical JSON sorts keys; a large file is its hash and counts', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(
      '{\n  "a": {\n    "d": 2\n  },\n  "b": 1\n}\n',
    );
    const rows = Array.from({ length: GOLDEN_INLINE_MAX_BYTES / 8 }, (_, i) => [`P-${i}`]);
    const big = JSON.parse(
      goldenOf({
        kind: 'sheets',
        sheets: [{ name: 'T', columns: [{ name: 'A', type: 'text' }], rows }],
      }),
    );
    expect(big).toEqual({
      kind: 'sheets',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      tabs: [{ name: 'T', columns: ['A:text'], rows: rows.length }],
    });
  });
});
