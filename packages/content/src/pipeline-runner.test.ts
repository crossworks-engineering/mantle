/**
 * The runner of a packaged pipeline, end to end: a real parser (server/parser
 * main.ts, booted on a loopback port with PARSER_TEST_PIPELINES=1) runs the
 * test-only package (packages/files/src/pipelines/pkg/test-echo) one step a
 * job, and runPackaged (./pipeline-runner.ts) runs the steps to the end.
 * What is pinned (docs/pipelines.md, "The runner", MV0 is done when):
 *  - one step with a write; two steps with one ask and a state;
 *  - a `not_mine`; a failure; a throw; a result over the limits;
 *  - the manifest's own time, the asks' cap, a model-free run;
 *  - the body of an `after` pipeline, the pictures of a write;
 *  - an id that is no package is a bad_request, and a failure counts
 *    against the pipeline and the bytes, not the job alone.
 *
 * And the end-to-end case of each move: a moved reader on its fixed set
 * gives the golden files of its old path through parseFileSheets, by one
 * pipelineRun job a file it reads, and none for a file the core's check on
 * the bytes in hand answers (./pipeline-golden-<id>.test.ts has the
 * in-process compare and its notes).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  isParserError,
  parserFailureKey,
  parserPipelineRun,
  parserText,
  resetParserFailures,
  tabHeadLine,
  tabRowLine,
  AFTER_CELL_MAX_CHARS,
  PIPELINE_API,
  type PipelineManifest,
} from '@mantle/files';
import { TEST_PIPELINES } from '@mantle/files/pipelines/pkg-test';
import { ensureWorkbookDoc } from '@mantle/content-core/table-model';
import { parseFileSheets, tabsOfSheets } from './file-database';
import { goldenOf } from './pipeline-golden';
import { afterBodyOf, runPackaged, type PipelineAsk } from './pipeline-runner';
import { writeFileDatabaseDoc } from './table-broker';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, '..', '..', '..', 'server', 'parser', 'src', 'main.ts');
const TOKEN = 'test-parser-token';
const ECHO = TEST_PIPELINES[0]!;
let child: ChildProcess;
let workdir: string;
const saved = { url: process.env.PARSER_URL, token: process.env.PARSER_TOKEN };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  workdir = mkdtempSync(path.join(os.tmpdir(), 'pipeline-runner-test-'));
  const port = await freePort();
  child = spawn(process.execPath, ['--no-env-file', MAIN], {
    cwd: path.dirname(path.dirname(MAIN)),
    env: {
      ...process.env,
      PARSER_PORT: String(port),
      PARSER_HOST: '127.0.0.1',
      PARSER_TOKEN: TOKEN,
      PARSER_WORKDIR: path.join(workdir, 'jobs'),
      PARSER_TEST_PIPELINES: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the parser did not start: ${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d.toString();
      if (out.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on('data', on);
    child.stderr!.on('data', on);
    child.once('exit', (code) => reject(new Error(`the parser exited ${code}: ${out}`)));
  });
  process.env.PARSER_URL = `http://127.0.0.1:${port}`;
  process.env.PARSER_TOKEN = TOKEN;
}, 60_000);

afterAll(() => {
  child?.kill('SIGKILL');
  rmSync(workdir, { recursive: true, force: true });
  if (saved.url === undefined) delete process.env.PARSER_URL;
  else process.env.PARSER_URL = saved.url;
  if (saved.token === undefined) delete process.env.PARSER_TOKEN;
  else process.env.PARSER_TOKEN = saved.token;
});

afterEach(() => resetParserFailures());

const body = (text = `${randomUUID()}\nP-101\nP-102\n`) => Buffer.from(text);
const file = (b: Buffer) => ({ name: 'a.echo', ext: 'echo', size: b.length, sha256: 'x' });
const run = (
  b: Buffer,
  options: Record<string, unknown>,
  more: { ask?: PipelineAsk; kind?: string } = {},
) => runPackaged(ECHO, b, file(b), { options, ...more });

async function failure(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isParserError(err)).toBe(true);
  return err as { code: string; retryable: boolean; message: string };
}

describe('a packaged pipeline through a real parser job', () => {
  it('one step with a write: the write input comes back, and nothing is written', async () => {
    const b = body();
    const out = await run(b, {}, { kind: 'pid' });
    expect(out.status).toBe('ok');
    expect(out.write?.tabs).toEqual([
      {
        name: 'Lines',
        columns: [{ name: 'Line', type: 'text' }],
        rows: b
          .toString()
          .split('\n')
          .filter(Boolean)
          .map((l) => [l]),
      },
    ]);
    expect(out.write?.description).toBe('3 lines, kind pid');
  }, 60_000);

  it('two steps with one ask and a state: the answer reaches step 2', async () => {
    const calls: unknown[] = [];
    const ask: PipelineAsk = async (call) => {
      calls.push(call);
      return { ok: true, output: { kind: 'pfd' } };
    };
    const out = await run(body(), { mode: 'ask' }, { ask });
    expect(calls).toEqual([
      { call: 'worker', worker: 'decider', input: { size: expect.any(Number) } },
    ]);
    expect(out.write?.tabs[0]?.rows).toEqual([[true, '{"kind":"pfd"}', 2, true]]);
  }, 60_000);

  it('a model-free run: the step that still asks gets refused, and no ask is made', async () => {
    const out = await run(body(), { mode: 'ask' });
    expect(out.write?.tabs[0]?.rows).toEqual([[false, 'refused', 2, true]]);
  }, 60_000);

  it('the asks of one worker are capped by the manifest', async () => {
    let n = 0;
    const capped: PipelineManifest = { ...ECHO, needs: { ...ECHO.needs, workers: { decider: 0 } } };
    const b = body();
    const out = await runPackaged(capped, b, file(b), {
      options: { mode: 'ask' },
      ask: async () => {
        n += 1;
        return { ok: true, output: 1 };
      },
    });
    expect(n).toBe(0);
    expect(out.write?.tabs[0]?.rows[0]?.[1]).toBe('refused');
  }, 60_000);

  it('a worker named as a key of the prototype is no worker: refused', async () => {
    let n = 0;
    const b = body();
    const out = await runPackaged(ECHO, b, file(b), {
      options: { mode: 'ask', worker: 'constructor' },
      ask: async () => {
        n += 1;
        return { ok: true, output: 1 };
      },
    });
    expect(n).toBe(0);
    expect(out.write?.tabs[0]?.rows[0]?.[1]).toBe('refused');
  }, 60_000);

  it('a step that still asks on the last allowed step is a failure: 2 for a router, 4 else', async () => {
    const steps: number[] = [];
    const ask: PipelineAsk = async (call) => {
      steps.push((call.input as { step: number }).step);
      return { ok: true, output: null };
    };
    const big: PipelineManifest = { ...ECHO, needs: { ...ECHO.needs, workers: { decider: 10 } } };
    const b = body();
    await expect(
      runPackaged({ ...big, router: true }, b, file(b), { options: { mode: 'loop' }, ask }),
    ).rejects.toThrow(/last allowed step \(2\)/);
    expect(steps).toEqual([1]);
    steps.length = 0;
    await expect(runPackaged(big, b, file(b), { options: { mode: 'loop' }, ask })).rejects.toThrow(
      /last allowed step \(4\)/,
    );
    expect(steps).toEqual([1, 2, 3]);
  }, 60_000);

  it('not_mine is an answer, not a failure', async () => {
    expect((await run(body(), { mode: 'not_mine' })).status).toBe('not_mine');
  }, 60_000);

  it('a step that fails and a step that throws are failed jobs, not counted', async () => {
    for (const mode of ['failed', 'throw']) {
      const err = await failure(run(body(), { mode }));
      expect(err.code).toBe('failed');
      expect(err.retryable).toBe(false);
    }
  }, 60_000);

  it('a result over the limits is refused by the check: failed', async () => {
    const err = await failure(run(body(), { mode: 'over' }));
    expect(err.code).toBe('failed');
    expect(err.message).toContain('more than 64 calls');
  }, 60_000);

  it("the manifest's own time stops the step: timeout, counted against the pipeline and the bytes", async () => {
    const b = body();
    const t0 = Date.now();
    const err = await failure(run(b, { mode: 'slow' }));
    expect(err.code).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(30_000);
    // The second counted failure of this pipeline on these bytes is final.
    const again = await failure(run(b, { mode: 'slow' }));
    expect(again.retryable).toBe(false);
    expect(parserFailureKey('pipelineRun', b, 'test-echo')).toMatch(
      /^pipelineRun:test-echo:[0-9a-f]{64}$/,
    );
  }, 90_000);

  it('the body of an after pipeline is read line by line, tab by tab', async () => {
    const b = Buffer.from(
      tabHeadLine('Other', ['A']) +
        tabRowLine(['skip me']) +
        tabHeadLine('Texts', ['Text', 'Page', 'Layer', 'X', 'Y']) +
        tabRowLine(['FIC-101', 1, 'TAGS', 10.5, 20]) +
        tabRowLine(['P-1001', 2, null, 1, 2]),
    );
    const out = await runPackaged(ECHO, b, undefined, { options: { mode: 'after' } });
    expect(out.write?.tabs[0]?.rows).toEqual([
      ['FIC-101', 1, 'TAGS', 10.5, 20],
      ['P-1001', 2, null, 1, 2],
    ]);
  }, 60_000);

  it('afterBodyOf: the Texts tab of a real database reaches the step, cells cut at the one cap', async () => {
    const abs = path.join(workdir, `${randomUUID()}.sqlite`);
    const long = 'A'.repeat(AFTER_CELL_MAX_CHARS + 10);
    const texts = {
      name: 'Texts',
      columns: ['Text', 'Page', 'Layer', 'X', 'Y'].map((name) => ({
        name,
        type: name === 'Text' || name === 'Layer' ? ('text' as const) : ('number' as const),
      })),
      rows: [
        ['FIC-101', 1, 'TAGS', 10.5, 20],
        [long, 2, 'NOTES', 1, 2],
      ],
    };
    const other = {
      name: 'Layers',
      columns: [{ name: 'Layer', type: 'text' as const }],
      rows: [['0']],
    };
    writeFileDatabaseDoc(abs, ensureWorkbookDoc({ tabs: tabsOfSheets([texts, other]) }), {
      fileId: randomUUID(),
      ownerId: randomUUID(),
    });
    const after: PipelineManifest = { ...ECHO, match: { ext: ['dwg'], after: 'texts-v1' } };
    const { body, warnings } = afterBodyOf(abs, after);
    expect(warnings).toEqual([]);
    const out = await runPackaged(after, body, undefined, { options: { mode: 'after' } });
    expect(out.write?.tabs[0]?.rows).toEqual([
      ['FIC-101', 1, 'TAGS', 10.5, 20],
      ['A'.repeat(AFTER_CELL_MAX_CHARS), 2, 'NOTES', 1, 2],
    ]);
    expect(() => afterBodyOf(abs, ECHO)).toThrow(/names no shape/);
  }, 60_000);

  it('a picture the write names comes back as its bytes', async () => {
    const out = await run(body(), { mode: 'picture' });
    expect(out.write?.pictures).toEqual([
      { file: 'pic.png', mime: 'image/png', caption: 'a picture' },
    ]);
    expect(out.pictures.get('pic.png')?.toString()).toBe('not really a png');
  }, 60_000);

  it('an id that is no package is a bad_request, and no path is built from it', async () => {
    for (const id of ['no-such', '../index', 'constructor']) {
      const err = await failure(
        parserPipelineRun(body(), id, { api: PIPELINE_API, step: 1, options: {} }),
      );
      expect(err.code).toBe('bad_request');
    }
  }, 60_000);
});

/** The routes of the parser jobs `fn` asks for. */
async function jobsOf<T>(fn: () => Promise<T>): Promise<{ out: T; jobs: string[] }> {
  const real = globalThis.fetch;
  const jobs: string[] = [];
  globalThis.fetch = ((url: unknown, init?: unknown) => {
    jobs.push(new URL(String(url)).pathname);
    return real(url as never, init as never);
  }) as typeof fetch;
  try {
    return { out: await fn(), jobs };
  } finally {
    globalThis.fetch = real;
  }
}

describe('plan-mspdi through a real parser job (the move MV1)', () => {
  const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'plan-mspdi');
  const names = readdirSync(path.join(PKG, 'fixtures'))
    .filter((n) => n.endsWith('.xml'))
    .sort();
  const fixture = (name: string) => readFileSync(path.join(PKG, 'fixtures', name));
  const golden = (name: string) =>
    JSON.parse(readFileSync(path.join(PKG, 'golden', name), 'utf8')) as unknown;

  it('the fixed set gives the golden files of the old path; a plan costs one pipelineRun job, a file that is no plan none', async () => {
    expect(names).toHaveLength(9);
    for (const name of names) {
      const bytes = fixture(name);
      const started = performance.now();
      const { out, jobs } = await jobsOf(() => parseFileSheets(bytes, 'xml'));
      const ms = Math.round(performance.now() - started);
      console.log(`plan-mspdi ${name}: ${bytes.length} bytes, ${ms} ms, jobs ${jobs.join(',')}`);
      // Another root, and a Project root that fails the full sniff: the
      // core's plan check on the bytes in hand answers, with no job.
      const none = name === 'not-plan.xml' || name === 'no-sniff.xml';
      expect(jobs, name).toEqual(none ? [] : ['/pipeline/run']);
      expect(JSON.parse(goldenOf(out)), name).toEqual(golden(`${name}.json`));
    }
  }, 120_000);

  it('the text job gives the same text for search', async () => {
    for (const name of names) {
      const text = await parserText(fixture(name), 'xml');
      expect(
        { sha256: createHash('sha256').update(text).digest('hex'), length: text.length },
        name,
      ).toEqual(golden(`${name}.text.json`));
    }
  }, 120_000);
});
