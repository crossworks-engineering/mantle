/**
 * An own pipeline in the job `pipelineRun` (docs/pipelines.md, "Own
 * pipelines"), read from a made-up mount folder (MANTLE_PIPELINES_DIR):
 *
 *  - the Bun template is imported from its folder and runs in this
 *    process; the Python template runs as a child of the job, reads
 *    request.json and in.bin, writes result.json; both give the same tabs;
 *  - a built-in id always wins: its version and its folder are never read;
 *  - an id or a version not of its form, a folder that is not there, or
 *    one that holds another version, is a `bad_request` (not counted);
 *  - a test's draft is read from `.drafts/<id>.<word>`, its word checked
 *    by the one path builder;
 *  - a pipeline.json that is not JSON says so;
 *  - the server's deadline of an own id is its folder's `needs.timeMs`;
 *  - a step that does not load fails; a Python step that loops is killed
 *    at its time (`timeout`); one that exits with an error is `failed`;
 *    one that writes no result.json is `failed`; one whose result.json is
 *    past the answer cap is `too_large`, read by its size only.
 *
 * The bare import (no auto-install) is held through a real parser job,
 * whose job process starts with --no-install
 * (packages/content/src/pipeline-runner.test.ts).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARSER_ANSWER_MAX_BYTES, parserJobTimeoutMs } from '@mantle/files/parser-wire';
import { PIPELINE_API } from '@mantle/files/pipelines/contract';
import { JobFailure } from './job-failure';
import { jobPaths } from './jobs';
import {
  builtinPythonEntry,
  jobHandle,
  pythonBuiltinsThere,
  runPipelineJob,
  stepOf,
} from './pipeline-job';
import { jobManifestOf } from './pipeline-index';
import { PICTURES_RESERVE_MS } from './pictures';

const TEMPLATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/pipeline-template',
);
const root = mkdtempSync(path.join(os.tmpdir(), 'pipeline-own-test-'));
const mount = path.join(root, 'pipelines');
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  vi.stubEnv('MANTLE_PIPELINES_DIR', mount);
  vi.stubEnv('PARSER_TEST_PIPELINES', '1');
});
afterEach(() => vi.unstubAllEnvs());

/** A template copied into the mount as `<id>/<version>`. */
function install(lang: 'bun' | 'python', at = ''): string {
  const id = lang === 'bun' ? 'lx9-logger' : 'lx9-logger-py';
  const dir = at || path.join(mount, id, '1.0.0');
  mkdirSync(path.dirname(dir), { recursive: true });
  cpSync(path.join(TEMPLATES, lang), dir, { recursive: true });
  return id;
}

/** A fresh job folder with the sample as its body. */
function job(body = readFileSync(path.join(TEMPLATES, 'sample.lx9'))) {
  const p = jobPaths(mkdtempSync(path.join(root, 'job-')));
  writeFileSync(p.input, body);
  return p;
}

const request = { api: PIPELINE_API, step: 1, options: { max_rows: 200000 } };

type Out = {
  ok: boolean;
  result: { status: string; calls: { input: { tabs: { name: string; rows: unknown[][] }[] } }[] };
};
const outOf = (p: ReturnType<typeof job>) => JSON.parse(readFileSync(p.outJson, 'utf8')) as Out;

async function failureOf(fn: () => Promise<unknown>): Promise<JobFailure | Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('it did not fail');
}

describe('an own pipeline from the mount', () => {
  it('the Bun template runs from its folder and gives its two tabs', async () => {
    const id = install('bun');
    const p = job();
    await runPipelineJob({ id, version: '1.0.0', request }, p);
    const out = outOf(p);
    expect(out.ok).toBe(true);
    expect(out.result.status).toBe('ok');
    expect(out.result.calls[0]!.input.tabs.map((t) => [t.name, t.rows.length])).toEqual([
      ['Readings', 3],
      ['Header', 2],
    ]);
  });

  it('the Python template runs as a child of the job, and gives the same tabs', async () => {
    const id = install('python');
    const p = job();
    const { step } = await stepOf({ id, version: '1.0.0' });
    const result = await step(request, jobHandle(p, Date.now() + PICTURES_RESERVE_MS + 30_000));
    expect(result.status).toBe('ok');
    const input = (result.calls![0] as { input: { tabs: { name: string; rows: unknown[][] }[] } })
      .input;
    expect(input.tabs.map((t) => [t.name, t.rows.length])).toEqual([
      ['Readings', 3],
      ['Header', 2],
    ]);
    expect(input.tabs[0]!.rows[0]).toEqual(['2026-01-04T08:00:00', 'PT-101', 412.5, 'kPa']);
    // It read request.json and wrote result.json in the job's folder only.
    expect(JSON.parse(readFileSync(path.join(p.dir, 'request.json'), 'utf8'))).toEqual(request);
  });

  it('a built-in id always wins: its version names no folder, and nothing is read from the mount', async () => {
    const p = job(Buffer.from('x'));
    await runPipelineJob(
      { id: 'test-echo', version: '9.9.9', request: { ...request, options: { mode: 'odd' } } },
      p,
    );
    expect(outOf(p).ok).toBe(true);
  });

  it('a word not of its form, no folder, or a folder of another package: bad_request', async () => {
    install('bun');
    const cases: Record<string, unknown>[] = [
      { id: '../lx9-logger', version: '1.0.0' },
      { id: 'lx9-logger', version: '../1.0.0' },
      { id: 'lx9-logger', version: '1.0' },
      { id: 'lx9-logger', version: '2.0.0' },
      { id: 'no-such', version: '1.0.0' },
    ];
    for (const named of cases) {
      const err = await failureOf(() => runPipelineJob({ ...named, request }, job()));
      expect(err, JSON.stringify(named)).toBeInstanceOf(JobFailure);
      expect((err as JobFailure).code, JSON.stringify(named)).toBe('bad_request');
    }
    // A folder of 1.1.0 that holds the manifest of 1.0.0 (a roll in between).
    install('bun', path.join(mount, 'lx9-logger', '1.1.0'));
    const err = await failureOf(() =>
      runPipelineJob({ id: 'lx9-logger', version: '1.1.0', request }, job()),
    );
    expect((err as JobFailure).code).toBe('bad_request');
    expect(err.message).toMatch(/another package/);
  });

  it("a test's draft is read from .drafts/<id>.<word>, whatever its version", async () => {
    const word = '0123456789abcdef';
    install('bun', path.join(mount, '.drafts', `lx9-logger.${word}`));
    const p = job();
    await runPipelineJob({ id: 'lx9-logger', draft: word, request }, p);
    expect(outOf(p).result.status).toBe('ok');
    // A word not of its form names no folder.
    for (const draft of [true, '../x', 'short', `${word}/..`]) {
      const err = await failureOf(() =>
        runPipelineJob({ id: 'lx9-logger', draft, request }, job()),
      );
      expect((err as JobFailure).code, String(draft)).toBe('bad_request');
    }
  });

  it('a pipeline.json that is not JSON says so, not that the folder is missing', async () => {
    install('bun');
    writeFileSync(path.join(mount, 'lx9-logger', '1.0.0', 'pipeline.json'), '{');
    const err = await failureOf(() =>
      runPipelineJob({ id: 'lx9-logger', version: '1.0.0', request }, job()),
    );
    expect((err as JobFailure).code).toBe('bad_request');
    expect(err.message).toMatch(/pipeline\.json of lx9-logger 1\.0\.0 is not JSON/);
  });

  it("the server's deadline of an own id is read from its folder", async () => {
    install('bun');
    const file = path.join(mount, 'lx9-logger', '1.0.0', 'pipeline.json');
    const m = JSON.parse(readFileSync(file, 'utf8')) as { needs: Record<string, unknown> };
    writeFileSync(file, JSON.stringify({ ...m, needs: { ...m.needs, timeMs: 5_000 } }));
    const manifest = await jobManifestOf({ id: 'lx9-logger', version: '1.0.0' });
    expect(parserJobTimeoutMs('pipelineRun', manifest.needs?.timeMs)).toBe(
      parserJobTimeoutMs('pipelineRun', 5_000),
    );
    expect(parserJobTimeoutMs('pipelineRun', 5_000)).not.toBe(parserJobTimeoutMs('pipelineRun'));
  });

  it('a Bun step that does not load fails; it is no bad_request', async () => {
    const dir = path.join(mount, 'broken-bun', '1.0.0');
    install('bun', dir);
    writeFileSync(
      path.join(dir, 'pipeline.json'),
      readFileSync(path.join(dir, 'pipeline.json'), 'utf8').replace('"lx9-logger"', '"broken-bun"'),
    );
    writeFileSync(path.join(dir, 'step.ts'), 'export const step = (;');
    const err = await failureOf(() =>
      runPipelineJob({ id: 'broken-bun', version: '1.0.0', request }, job()),
    );
    expect(err instanceof JobFailure && err.code === 'bad_request').toBe(false);
  });

  it('a Python step that loops is killed at its time: timeout', async () => {
    const id = install('python');
    writeFileSync(path.join(mount, id, '1.0.0', 'step.py'), 'while True:\n    pass\n');
    const p = job();
    const { step } = await stepOf({ id, version: '1.0.0' });
    const t0 = Date.now();
    const err = await failureOf(() =>
      step(request, jobHandle(p, Date.now() + PICTURES_RESERVE_MS + 1_500)),
    );
    expect((err as JobFailure).code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('a Python step that ends with an error is failed, with its last words', async () => {
    const id = install('python');
    writeFileSync(path.join(mount, id, '1.0.0', 'step.py'), 'raise SystemExit("made-up error")\n');
    const err = await failureOf(async () => {
      const { step } = await stepOf({ id, version: '1.0.0' });
      return step(request, jobHandle(job(), Date.now() + PICTURES_RESERVE_MS + 30_000));
    });
    expect((err as JobFailure).code).toBe('failed');
    expect(err.message).toMatch(/made-up error/);
  });

  it('a Python step that writes no result.json is failed', async () => {
    const id = install('python');
    writeFileSync(path.join(mount, id, '1.0.0', 'step.py'), 'pass\n');
    const err = await failureOf(async () => {
      const { step } = await stepOf({ id, version: '1.0.0' });
      return step(request, jobHandle(job(), Date.now() + PICTURES_RESERVE_MS + 30_000));
    });
    expect((err as JobFailure).code).toBe('failed');
    expect(err.message).toMatch(/no result\.json/);
  });

  it('a result.json past the answer cap is too_large, read by its size only', async () => {
    const id = install('python');
    // A sparse file: its size is past the cap, its bytes take no disk.
    writeFileSync(
      path.join(mount, id, '1.0.0', 'step.py'),
      `import os, sys\nwith open(os.path.join(sys.argv[1], 'result.json'), 'wb') as f:\n    f.truncate(${PARSER_ANSWER_MAX_BYTES + 1})\n`,
    );
    const err = await failureOf(async () => {
      const { step } = await stepOf({ id, version: '1.0.0' });
      return step(request, jobHandle(job(), Date.now() + PICTURES_RESERVE_MS + 30_000));
    });
    expect((err as JobFailure).code).toBe('too_large');
  });
});

describe('a Python built-in (drawing-raster)', () => {
  it('runs its file of the CAD tier by its name, never from the mount', async () => {
    const { manifest } = await stepOf({ id: 'drawing-raster' });
    expect(manifest).toMatchObject({ id: 'drawing-raster', runtime: 'python', entry: 'drawing_raster.py' });
    expect(builtinPythonEntry('drawing_raster.py')).toBe(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cad', 'drawing_raster.py'),
    );
    // A path in the entry never leaves the folder.
    expect(path.basename(builtinPythonEntry('../../x/drawing_raster.py'))).toBe('drawing_raster.py');
    expect(path.dirname(builtinPythonEntry('../../x/drawing_raster.py'))).toBe(
      path.dirname(builtinPythonEntry('drawing_raster.py')),
    );
    expect(await pythonBuiltinsThere()).toBe(1);
  });

  // With the CAD tier's venv only (Pillow, numpy): the image, or a bench
  // with PARSER_PYTHON. Bytes that are no TIFF are not its own.
  it.skipIf(!process.env.PARSER_PYTHON)('says not_mine for bytes that are no TIFF', async () => {
    const p = job(Buffer.from('not a tiff at all'));
    const { step } = await stepOf({ id: 'drawing-raster' });
    const result = await step(
      {
        api: PIPELINE_API,
        step: 1,
        options: {},
        file: { name: 'a.tif', ext: 'tif', size: 17, sha256: 'x' },
      },
      jobHandle(p, Date.now() + PICTURES_RESERVE_MS + 30_000),
    );
    expect(result).toEqual({ status: 'not_mine' });
  });
});
