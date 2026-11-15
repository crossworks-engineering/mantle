/**
 * The runner of a packaged pipeline, end to end: a real parser (server/parser
 * main.ts, booted on a loopback port with PARSER_TEST_PIPELINES=1) runs the
 * test-only package (packages/files/src/pipelines/pkg/test-echo) one step a
 * job, and runPackaged (./pipeline-runner.ts) runs the steps to the end.
 * What is pinned (docs/pipelines.md, "The runner", MV0 is done when):
 *  - one step with a write; two steps with one ask and a state;
 *  - a `not_mine`; a failure; a throw; a result over the limits;
 *  - the server's kill at the manifest's own time, the asks' cap, a
 *    model-free run;
 *  - the body of an `after` pipeline, the pictures of a write;
 *  - an id that is no package is a bad_request, and a failure counts
 *    against the pipeline and the bytes, not the job alone.
 *
 * And the end-to-end case of each move: a moved reader on its fixed set
 * gives the golden files of its old path through parseFileSheets, by one
 * pipelineRun job a file it reads (for plot-dwf also the text and the
 * pictures, which stay on their jobs), and none for a file the core's check
 * on the bytes in hand answers (./pipeline-golden-<id>.test.ts has the
 * in-process compare and its notes). For the `after` pipeline site-tags the
 * input is a made-up database, read through afterSheetsOf. For `sheet` (MV3)
 * the CSV is a parser job now, where the old path read it in the brain's
 * process.
 *
 * And an own pipeline (P3-1, docs/pipelines.md, "Own pipelines"), read
 * from the parser's mount (a folder of this test): the Bun and the Python
 * template give their tabs; a bare import fails at once (no auto-install);
 * a version with no folder is a bad_request, never counted; a worker call
 * of an own step is refused, as every run of a reader is model-free.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILTIN_PIPELINES,
  effectiveOptions,
  isParserError,
  optionsHash,
  withAfterEntry,
  parserFailureKey,
  parserPdfDrawing,
  parserPdfPieces,
  parserPipelineRun,
  parserText,
  resetParserFailures,
  tabHeadLine,
  tabRowLine,
  AFTER_CELL_MAX_CHARS,
  CLOCK_COLUMNS,
  PIPELINE_API,
  sketchPagesOf,
  type PipelineManifest,
} from '@mantle/files';
import { extractEmbeddedImages } from '@mantle/files/embedded-images';
import { TEST_PIPELINES } from '@mantle/files/pipelines/pkg-test';
import { ensureWorkbookDoc } from '@mantle/content-core/table-model';
import { afterSheetsOf, parseFileSheets, tabsOfSheets } from './file-database';
import { afterGoldenOf, goldenOf, writeFixtureDatabase } from './pipeline-golden';
import {
  AFTER_BODY_MAX_BYTES,
  afterBodyOf,
  runPackaged,
  stepFileOf,
  type PipelineAsk,
} from './pipeline-runner';
import { writeFileDatabaseDoc } from './table-broker';
import { pipelinesOf, type BoxPipeline } from './pipeline-registry';
/** The box's pipelines (the registry): the built-ins. */
const pipelines = pipelinesOf([]);

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
      // The read-only mount of own pipelines (docs/pipelines.md, "Own
      // pipelines"): a folder of this test.
      MANTLE_PIPELINES_DIR: path.join(workdir, 'pipelines'),
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

  it("the server kills a step at the manifest's own time: timeout, counted against the pipeline and the bytes", async () => {
    // The step is a synchronous busy loop (test-echo `slow`), so no timer of
    // the job could stop it: only the server's kill at needs.timeMs (3 s).
    const b = body();
    const t0 = Date.now();
    const err = await failure(run(b, { mode: 'slow' }));
    expect(err.code).toBe('timeout');
    expect(err.message).toContain('past its 3 s limit and was killed');
    expect(err.retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(30_000);
    // The second counted failure of this pipeline on these bytes is final.
    const again = await failure(run(b, { mode: 'slow' }));
    expect(again.retryable).toBe(false);
    // Counted against the pipeline at its version (parserPipelineRun).
    expect(parserFailureKey('pipelineRun', b, `${ECHO.id}@${ECHO.version}`)).toMatch(
      /^pipelineRun:test-echo@\d+\.\d+\.\d+:[0-9a-f]{64}$/,
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

  it('afterBodyOf: a body past the byte budget stops there, with the warning of the row cap', () => {
    const abs = path.join(workdir, `${randomUUID()}.sqlite`);
    const texts = {
      name: 'Texts',
      columns: [{ name: 'Text', type: 'text' as const }],
      rows: Array.from({ length: 100 }, (_, i) => [`NOTE ${i} ${'X'.repeat(90)}`]),
    };
    writeFileDatabaseDoc(abs, ensureWorkbookDoc({ tabs: tabsOfSheets([texts]) }), {
      fileId: randomUUID(),
      ownerId: randomUUID(),
    });
    const after: PipelineManifest = { ...ECHO, match: { ext: ['dwg'], after: 'texts-v1' } };
    const whole = afterBodyOf(abs, after);
    expect(whole.warnings).toEqual([]);
    expect(whole.body.toString('utf8').trim().split('\n')).toHaveLength(101);
    // A budget of about a third: the head line and the rows that fit.
    const cut = afterBodyOf(abs, after, Math.floor(whole.body.length / 3));
    const lines = cut.body.toString('utf8').trim().split('\n');
    expect(cut.body.length).toBeLessThanOrEqual(Math.floor(whole.body.length / 3));
    expect(cut.warnings).toEqual([`Only the first ${lines.length - 1} texts were read.`]);
    expect(whole.body.toString('utf8').startsWith(cut.body.toString('utf8'))).toBe(true);
    expect(AFTER_BODY_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

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
        parserPipelineRun(
          body(),
          { id, version: '1.0.0' },
          { api: PIPELINE_API, step: 1, options: {} },
        ),
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
    expect(names).toHaveLength(10);
    for (const name of names) {
      const bytes = fixture(name);
      const started = performance.now();
      const { out, jobs } = await jobsOf(() => parseFileSheets(bytes, 'xml', { pipelines }));
      const ms = Math.round(performance.now() - started);
      console.log(`plan-mspdi ${name}: ${bytes.length} bytes, ${ms} ms, jobs ${jobs.join(',')}`);
      // Another root, and a Project root that fails the full sniff: the
      // core's plan check on the bytes in hand answers, with no job.
      const none = name === 'not-plan.xml' || name === 'no-sniff.xml';
      expect(jobs, name).toEqual(none ? [] : ['/pipeline/run']);
      expect(JSON.parse(goldenOf(out)), name).toEqual(golden(`${name}.json`));
    }
  }, 120_000);

  it('odd-number.xml: a number that is not finite is null after the job, and the plan keeps its rows', async () => {
    const out = await parseFileSheets(fixture('odd-number.xml'), 'xml', { pipelines });
    if (out.kind !== 'sheets') throw new Error(`no sheets: ${JSON.stringify(out)}`);
    const tasks = out.sheets[0]!;
    const col = tasks.columns.findIndex((c) => c.name === 'Duration (hours)');
    expect(tasks.rows).toHaveLength(2);
    expect(tasks.rows.map((r) => r[col])).toEqual([8, null]);
  }, 60_000);

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

describe('plot-dwf through a real parser job (the move MV4)', () => {
  const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'plot-dwf');
  const names = readdirSync(path.join(PKG, 'fixtures'))
    .filter((n) => n.endsWith('.dwf'))
    .sort();
  const fixture = (name: string) => readFileSync(path.join(PKG, 'fixtures', name));
  const golden = (name: string) =>
    JSON.parse(readFileSync(path.join(PKG, 'golden', name), 'utf8')) as unknown;
  const failed = { throws: { code: 'failed', retryable: false } };

  it('the fixed set gives the golden files of the old path, by one pipelineRun job a file', async () => {
    expect(names).toHaveLength(8);
    for (const name of names) {
      const bytes = fixture(name);
      const started = performance.now();
      const { out, jobs } = await jobsOf(() => parseFileSheets(bytes, 'dwf', { pipelines }));
      const ms = Math.round(performance.now() - started);
      console.log(`plot-dwf ${name}: ${bytes.length} bytes, ${ms} ms, jobs ${jobs.join(',')}`);
      // The old path sent every .dwf to the parser (the grid job), a file
      // that is not a DWF too: one job before, one job now.
      expect(jobs, name).toEqual(['/pipeline/run']);
      expect(JSON.parse(goldenOf(out)), name).toEqual(golden(`${name}.json`));
    }
  }, 120_000);

  it('the text job gives the same text for search, and the images job the same number of sheet pictures', async () => {
    for (const name of names) {
      const bytes = fixture(name);
      const text = await parserText(bytes, 'dwf').then(
        (t) => ({ sha256: createHash('sha256').update(t).digest('hex'), length: t.length }),
        (e: unknown) => (isParserError(e) && e.code === 'failed' ? failed : e),
      );
      expect(text, name).toEqual(golden(`${name}.text.json`));
      const pictures = await extractEmbeddedImages(bytes, 'dwf').then(
        (r) => ({ pictures: r.images.length }),
        (e: unknown) => (isParserError(e) && e.code === 'failed' ? failed : e),
      );
      expect(pictures, name).toEqual(golden(`${name}.pictures.json`));
    }
  }, 120_000);
});

describe('site-tags through a real parser job (the move MV2)', () => {
  const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'site-tags');
  const SITE = BUILTIN_PIPELINES.find((p) => p.id === 'site-tags')!;
  const OPTIONS = (
    JSON.parse(readFileSync(path.join(PKG, 'fixtures', 'options.json'), 'utf8')) as {
      options: Record<string, unknown>;
    }
  ).options;
  const names = readdirSync(path.join(PKG, 'fixtures'))
    .filter((n) => n.endsWith('.json') && n !== 'options.json')
    .map((n) => n.replace(/\.json$/, ''))
    .sort();
  const golden = (name: string) =>
    JSON.parse(readFileSync(path.join(PKG, 'golden', name), 'utf8')) as unknown;
  const dbOf = (name: string) => {
    const abs = path.join(workdir, `site-tags-${name}.sqlite`);
    writeFixtureDatabase(path.join(PKG, 'fixtures', `${name}.json`), abs);
    return abs;
  };

  it('the fixed set gives the golden files of the old path; no work is no job', async () => {
    expect(names).toHaveLength(9);
    for (const name of names) {
      const abs = dbOf(name);
      for (const [set, given] of [
        ['defaults', {}],
        ['options', OPTIONS],
      ] as const) {
        const options = effectiveOptions(SITE, given);
        const started = performance.now();
        const { out, jobs } = await jobsOf(() => afterSheetsOf(SITE, abs, options));
        const ms = Math.round(performance.now() - started);
        console.log(`site-tags ${name} ${set}: ${ms} ms, jobs ${jobs.join(',')}`);
        if (name === 'no-texts' || name === 'empty-texts') {
          // The old empty tab, which no writer keeps; now no job and no tab
          // (the note in ./pipeline-golden-site-tags.test.ts).
          expect(out, name).toEqual({ sheets: [], warnings: [] });
          expect(jobs, name).toEqual([]);
          continue;
        }
        expect(jobs, name).toEqual(['/pipeline/run']);
        const entry = withAfterEntry(undefined, SITE, optionsHash(SITE, options));
        expect(JSON.parse(afterGoldenOf(out, entry)), `${name} ${set}`).toEqual(
          golden(`${name}.${set}.json`),
        );
      }
    }
  }, 600_000);

  it('the time of one run on the largest made-up tab (the median of 7)', async () => {
    const abs = dbOf('large');
    const times: number[] = [];
    let rows = 0;
    for (let i = 0; i < 7; i += 1) {
      const started = performance.now();
      const out = await afterSheetsOf(SITE, abs, {});
      times.push(performance.now() - started);
      rows = out.sheets[0]?.rows.length ?? 0;
    }
    times.sort((a, b) => a - b);
    console.log(
      `site-tags large (503,500 Texts rows, 500,000 read, ${rows} tags): median ${times[3]!.toFixed(0)} ms of 7`,
    );
    expect(rows).toBe(20_956);
  }, 600_000);
});

describe('sheet through a real parser job (the move MV3)', () => {
  const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'sheet');
  const names = readdirSync(path.join(PKG, 'fixtures'))
    .filter((n) => !n.startsWith('.'))
    .sort();
  const fixture = (name: string) => readFileSync(path.join(PKG, 'fixtures', name));
  const golden = (name: string) =>
    JSON.parse(readFileSync(path.join(PKG, 'golden', `${name}.json`), 'utf8')) as unknown;
  const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1);
  const SHEET = BUILTIN_PIPELINES.find((p) => p.id === 'sheet')!;

  it('the fixed set gives the golden files of the old path, by one pipelineRun job a file', async () => {
    expect(names).toHaveLength(22);
    for (const name of names.filter((n) => n !== 'macro.xlsm' && n !== 'over-cap.csv')) {
      resetParserFailures();
      const bytes = fixture(name);
      const started = performance.now();
      const { out, jobs } = await jobsOf(() => parseFileSheets(bytes, extOf(name), { pipelines }));
      const ms = Math.round(performance.now() - started);
      console.log(`sheet ${name}: ${bytes.length} bytes, ${ms} ms, jobs ${jobs.join(',')}`);
      expect(jobs, name).toEqual(['/pipeline/run']);
      // The unreadable ones too: a failed job is a verdict at once, so the
      // word comes on the first read, as on the old path.
      expect(JSON.parse(goldenOf(out)), name).toEqual(golden(name));
    }
  }, 180_000);

  it('a CSV over the early cap costs no job', async () => {
    const saved = process.env.MANTLE_FILE_DB_CSV_MAX_MB;
    process.env.MANTLE_FILE_DB_CSV_MAX_MB = '0.25';
    try {
      const bytes = fixture('over-cap.csv');
      const capped = await jobsOf(() => parseFileSheets(bytes, 'csv', { pipelines }));
      expect(capped.jobs).toEqual([]);
      expect(capped.out).toEqual(golden('over-cap.csv'));
    } finally {
      if (saved === undefined) delete process.env.MANTLE_FILE_DB_CSV_MAX_MB;
      else process.env.MANTLE_FILE_DB_CSV_MAX_MB = saved;
    }
  }, 60_000);

  it('an xlsm (no upload reaches the reader with it) reads the same through the job', async () => {
    const bytes = fixture('macro.xlsm');
    const run = await runPackaged(
      SHEET,
      bytes,
      { name: 'macro.xlsm', ext: 'xlsm', size: bytes.length, sha256: 'x' },
      { options: {} },
    );
    expect(run.status).toBe('ok');
    expect(JSON.parse(goldenOf({ kind: 'sheets', sheets: run.write?.tabs ?? [] }))).toEqual(
      golden('macro.xlsm'),
    );
  }, 60_000);
});

describe('the PDF set through a real parser job (the move MV5)', () => {
  const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'drawing-pdf');
  const names = readdirSync(path.join(PKG, 'fixtures'))
    .filter((n) => n.endsWith('.pdf'))
    .sort();
  const fixture = (name: string) => readFileSync(path.join(PKG, 'fixtures', name));
  const golden = (name: string) =>
    JSON.parse(readFileSync(path.join(PKG, 'golden', name), 'utf8')) as unknown;
  /** The clock columns (CLOCK_COLUMNS): null, as in the golden files. */
  const gold = (parsed: Awaited<ReturnType<typeof parseFileSheets>>) => {
    if (parsed.kind !== 'sheets') return JSON.parse(goldenOf(parsed)) as unknown;
    const sheets = parsed.sheets.map((s) => {
      const clock = CLOCK_COLUMNS.get(s.name) ?? [];
      const hit = s.columns.map((c) => clock.includes(c.name));
      return { ...s, rows: s.rows.map((r) => r.map((v, j) => (hit[j] ? null : v))) };
    });
    return JSON.parse(goldenOf({ ...parsed, sheets })) as unknown;
  };

  it('the fixed set gives the golden files of the old path: the router job, then the reader job', async () => {
    expect(names).toHaveLength(9);
    for (const name of names) {
      const bytes = fixture(name);
      const { out, jobs } = await jobsOf(() => parseFileSheets(bytes, 'pdf', { pipelines }));
      expect(gold(out), name).toEqual(golden(`${name}.json`));
      expect(jobs, name).toEqual(
        out.kind === 'sheets' ? ['/pipeline/run', '/pipeline/run'] : ['/pipeline/run'],
      );
    }
  }, 300_000);

  it("an unsure file: the router's ask reaches the core, its answer the File tab", async () => {
    const answer = {
      kind: 'pfd',
      confidence: 0.912,
      model: 'made-up-model',
      mode: 'live' as const,
      used: true,
    };
    const asked: unknown[] = [];
    const out = await parseFileSheets(fixture('unsure-vector.pdf'), 'pdf', {
      pipelines,
      pdfKind: async (state) => {
        asked.push(state);
        return answer;
      },
    });
    expect(asked).toHaveLength(1);
    expect(gold(out)).toEqual(golden('unsure-vector.pdf.decider-live-pfd.json'));
  }, 120_000);

  it('a read again with the stored kind is one reader job and asks nothing', async () => {
    const { out, jobs } = await jobsOf(() =>
      parseFileSheets(fixture('pid.pdf'), 'pdf', {
        pipelines,
        pdfStored: { kind: 'pid', decision: null },
      }),
    );
    expect(jobs).toEqual(['/pipeline/run']);
    expect(gold(out)).toEqual(golden('pid.pdf.json'));
  }, 120_000);

  it("the sketch read's kit jobs through a real parser: the page facts, then the pieces, no model", async () => {
    // The core path of the sketch read (server/api/src/agent/extract/pdf-sketch.ts)
    // runs these two jobs before its first vision call. With no OpenCV (the
    // host lane) a page is refused; in the image every picture is a PNG
    // (the parser image's probe pdf-sketch-probe.sh).
    const bytes = fixture('scan.pdf');
    const drawing = await parserPdfDrawing(bytes);
    expect(drawing.kind).toBe('scan');
    const { pages } = sketchPagesOf(drawing, 'scan');
    expect(pages).toEqual([1]);
    const cut = await parserPdfPieces(bytes, pages);
    expect(cut.map((p) => p.page)).toEqual(pages);
    for (const p of cut) {
      expect(['ok', 'refused', 'no_picture', 'over_budget']).toContain(p.status);
      for (const png of p.pictures) expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    }
  }, 240_000);

  it('the time of one read of each file of the before list (the median of 7)', async () => {
    const before: Record<string, string> = {
      pid: 'pid.pdf',
      isometric: 'isometric.pdf',
      'other drawing': 'other-drawing.pdf',
      document: 'document.pdf',
      'odd values': 'odd-values.pdf',
      damaged: 'damaged.pdf',
      'unsure raster': 'unsure.pdf',
      scan: 'scan.pdf',
    };
    for (const [label, name] of Object.entries(before)) {
      const bytes = fixture(name);
      const times: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        resetParserFailures();
        const started = performance.now();
        await parseFileSheets(bytes, 'pdf', { pipelines });
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      console.log(`MV5 cost ${label}: median ${times[3]!.toFixed(0)} ms of 7`);
    }
  }, 600_000);
});

const TEMPLATES = path.join(HERE, '..', '..', '..', 'docs', 'pipeline-template');

/** A package on the parser's mount as `<id>/1.0.0`, from a template, with
 *  its manifest changed and files added; its manifest as the registry
 *  gives it (an own pipeline). */
function ownOnMount(
  lang: 'bun' | 'python',
  over: Record<string, unknown> = {},
  files: Record<string, string> = {},
): BoxPipeline {
  const base = JSON.parse(
    readFileSync(path.join(TEMPLATES, lang, 'pipeline.json'), 'utf8'),
  ) as PipelineManifest;
  const manifest = { ...base, ...over } as PipelineManifest;
  const dir = path.join(workdir, 'pipelines', manifest.id, manifest.version);
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(TEMPLATES, lang), dir, { recursive: true });
  writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return { ...manifest, source: 'own' };
}

const sample = () => readFileSync(path.join(TEMPLATES, 'sample.lx9'));
const runOwn = (p: BoxPipeline, b = sample()) =>
  runPackaged(p, b, stepFileOf(b, 'lx9'), { options: { max_rows: 200000 } });

describe('an own pipeline through a real parser job (P3-1)', () => {
  it('the Bun template, from the mount: its two tabs', async () => {
    const out = await runOwn(ownOnMount('bun'));
    expect(out.status).toBe('ok');
    expect(out.write?.tabs.map((t) => [t.name, t.rows.length])).toEqual([
      ['Readings', 3],
      ['Header', 2],
    ]);
  });

  it('the Python template, a child of the job: the same tabs', async () => {
    const out = await runOwn(ownOnMount('python'));
    expect(out.status).toBe('ok');
    expect(out.write?.tabs.map((t) => [t.name, t.rows.length])).toEqual([
      ['Readings', 3],
      ['Header', 2],
    ]);
  });

  it('a bare import fails to load at once: the job starts with --no-install, so nothing is fetched', async () => {
    const p = ownOnMount(
      'bun',
      { id: 'bare-import' },
      {
        'step.ts':
          "import pad from 'left-pad';\nexport const step = async () => ({ status: 'ok', warnings: [pad('x', 2)] });\n",
      },
    );
    const t0 = Date.now();
    const err = await failure(runOwn(p));
    expect(err.code).not.toBe('bad_request');
    expect(err.code).not.toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it("a test's draft: read from its own folder by the word, not by its version", async () => {
    const word = '0123456789abcdef0123';
    const base = ownOnMount('bun', { id: 'draft-run' });
    // No folder of this version: only the draft folder holds the package.
    const p: BoxPipeline = { ...base, version: '7.7.7', draft: word };
    const dir = path.join(workdir, 'pipelines', '.drafts', `draft-run.${word}`);
    mkdirSync(path.dirname(dir), { recursive: true });
    cpSync(path.join(workdir, 'pipelines', 'draft-run', base.version), dir, { recursive: true });
    const out = await runOwn(p);
    expect(out.status).toBe('ok');
    expect(out.write?.tabs.map((t) => [t.name, t.rows.length])).toEqual([
      ['Readings', 3],
      ['Header', 2],
    ]);
    // Another word names no folder.
    const err = await failure(runOwn({ ...p, draft: 'ffffffffffffffff' }));
    expect(err.code).toBe('bad_request');
  });

  it('a version whose folder is not there is a bad_request, never counted', async () => {
    const p = { ...ownOnMount('bun', { id: 'gone-version' }), version: '9.0.0' };
    for (let i = 0; i < 3; i += 1) {
      const err = await failure(runOwn(p));
      expect(err.code).toBe('bad_request');
      expect(err.message).toMatch(/no package folder/);
    }
  });

  it("an own step's worker call is refused: no ask, no worker called", async () => {
    const p = ownOnMount(
      'bun',
      { id: 'asks-a-worker' },
      {
        'step.ts':
          "export const step = async (req) => req.step === 1 ? { status: 'ok', calls: [{ call: 'worker', worker: 'vision', input: {} }] } : { status: 'ok', warnings: [JSON.stringify(req.answers)] };\n",
      },
    );
    const out = await runOwn(p);
    expect(out.status).toBe('ok');
    expect(out.warnings).toEqual([JSON.stringify([{ ok: false, error: 'refused' }])]);
  });
});
