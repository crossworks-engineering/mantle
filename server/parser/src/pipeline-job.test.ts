/**
 * The job `pipelineRun` checks and sends the JSON form of a step's result
 * (./pipeline-job.ts), as the old path's out.json was JSON: a number cell
 * that is not finite, and a cell that is undefined, is null, and the result
 * stands. A result JSON cannot hold is a refused result, `failed`. A result
 * over the answer cap is `too_large`, final, before its text is parsed.
 * The step is the test-only package (pkg/test-echo), run in this process.
 * The CAD tier's children get the time left to the handle's deadline, not
 * the whole job time (the CAD tier is faked here: no Python).
 * The pictures of an answer (picturesOf): those a write names and the one
 * of each vision ask, each one time, from the job's folder only, inside the
 * answer's budget.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARSER_PICTURES_BUDGET_BYTES } from '@mantle/files/parser-wire';
import { FILE_TABS_WRITE, PIPELINE_API, VISION_WORKER } from '@mantle/files/pipelines/contract';
import { JobFailure } from './job-failure';
import { jobPaths } from './jobs';
import { jobHandle, jsonOf, picturesOf, runPipelineJob } from './pipeline-job';
import { PICTURES_RESERVE_MS } from './pictures';

/** The time each faked child of the CAD tier was given. */
const given = vi.hoisted(() => ({
  dwg: [] as number[],
  dwf: [] as number[],
  sheet: [] as number[],
}));
vi.mock('./cad', async (importOriginal) => {
  const { promises: fsp } = await import('node:fs');
  return {
    ...(await importOriginal<typeof import('./cad')>()),
    dwgRender: async (_in: string, _o: unknown, _dir: string, out: string, ms: number) => {
      given.dwg.push(ms);
      await fsp.writeFile(out, '{}');
    },
    dwfRenderer: (_dir: string, ms: number) => async () => {
      given.dwf.push(ms);
      return { ok: false, code: 'faked', message: 'faked' };
    },
    sheetPictures: async (_in: string, _spec: unknown, _dir: string, ms: number) => {
      given.sheet.push(ms);
      return null;
    },
  };
});

const root = mkdtempSync(path.join(os.tmpdir(), 'pipeline-job-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => vi.stubEnv('PARSER_TEST_PIPELINES', '1'));
afterEach(() => vi.unstubAllEnvs());

describe('the job sends the JSON form of a result', () => {
  it('NaN, Infinity, -Infinity and undefined cells are null, and the tab keeps its row', async () => {
    const p = jobPaths(mkdtempSync(path.join(root, 'job-')));
    writeFileSync(p.input, 'x');
    await runPipelineJob(
      { id: 'test-echo', request: { api: PIPELINE_API, step: 1, options: { mode: 'odd' } } },
      p,
    );
    const out = JSON.parse(readFileSync(p.outJson, 'utf8')) as {
      ok: boolean;
      result: { status: string; calls: { input: { tabs: { rows: unknown[][] }[] } }[] };
    };
    expect(out.ok).toBe(true);
    expect(out.result.status).toBe('ok');
    expect(out.result.calls[0]!.input.tabs[0]!.rows).toEqual([[null, null, null, null, 1]]);
  });

  it('a result JSON cannot hold is refused: failed', () => {
    const cycle: Record<string, unknown> = { status: 'ok' };
    cycle.self = cycle;
    for (const raw of [cycle, undefined, { status: 'ok', n: 1n }]) {
      let err: unknown;
      try {
        jsonOf(raw);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(JobFailure);
      expect((err as JobFailure).code).toBe('failed');
    }
  });

  it('a result over the answer cap is too_large, final: the job throws it before it parses the text', () => {
    const raw = { status: 'ok', calls: [], warnings: ['x'.repeat(200)] };
    const size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    expect(jsonOf(raw, size)).toBe(JSON.stringify(raw));
    let err: unknown;
    try {
      jsonOf(raw, size - 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JobFailure);
    expect((err as JobFailure).code).toBe('too_large');
    expect((err as JobFailure).final).toBe(true);
  });
});

describe('the CAD tier gets the time left, not the whole job time', () => {
  it('cadRender, dwfRender and sheetPictures get the time to the handle deadline, at the call', async () => {
    const p = jobPaths(mkdtempSync(path.join(root, 'job-')));
    writeFileSync(p.input, 'x');
    const left = 60_000;
    const job = jobHandle(p, Date.now() + PICTURES_RESERVE_MS + left);
    expect(await job.cadRender({})).toEqual({});
    await job.dwfRender(Buffer.from('x'), { dpi: 100 });
    expect(await job.sheetPictures({ ext: 'tif', pictures: [] })).toBeNull();
    for (const ms of [...given.dwg, ...given.dwf, ...given.sheet]) {
      expect(ms).toBeLessThanOrEqual(left);
      expect(ms).toBeGreaterThan(left - 5_000);
    }
    expect([given.dwg.length, given.dwf.length, given.sheet.length]).toEqual([1, 1, 1]);
  });
});

describe('the pictures of an answer', () => {
  const ask = (picture: unknown, worker = VISION_WORKER) => ({
    call: 'worker',
    worker,
    key: 'k',
    input: { picture, fields: [{ name: 'Revision' }] },
  });
  const write = (...files: string[]) => ({
    call: 'tool',
    tool: FILE_TABS_WRITE,
    input: { tabs: [], pictures: files.map((file) => ({ file, mime: 'image/png' })) },
  });
  const folder = () => {
    const dir = mkdtempSync(path.join(root, 'pics-'));
    writeFileSync(path.join(dir, 'sheet.png'), 'sheet');
    writeFileSync(path.join(dir, 'right-side.png'), 'right');
    return dir;
  };
  const b64 = (text: string) => Buffer.from(text).toString('base64');

  it('sends the picture of each vision ask, and those of a write, in the order of the calls', async () => {
    const dir = folder();
    expect(await picturesOf(dir, [ask('sheet.png'), ask('right-side.png')])).toEqual([
      { file: 'sheet.png', bytes_base64: b64('sheet') },
      { file: 'right-side.png', bytes_base64: b64('right') },
    ]);
    expect(await picturesOf(dir, [write('right-side.png'), ask('sheet.png')])).toEqual([
      { file: 'right-side.png', bytes_base64: b64('right') },
      { file: 'sheet.png', bytes_base64: b64('sheet') },
    ]);
  });

  it('sends each file one time, however many calls name it', async () => {
    const dir = folder();
    const sent = await picturesOf(dir, [
      ask('sheet.png'),
      ask('sheet.png'),
      write('sheet.png', 'right-side.png', 'right-side.png'),
    ]);
    expect(sent.map((p) => p.file)).toEqual(['sheet.png', 'right-side.png']);
  });

  it('sends nothing for an ask of another worker, an ask with no picture name, or a file that is not there', async () => {
    const dir = folder();
    expect(
      await picturesOf(dir, [
        ask('sheet.png', 'decider'),
        ask(undefined),
        ask(7),
        ask('not-there.png'),
        { call: 'worker', worker: VISION_WORKER },
        { call: 'tool', tool: 'other_tool', input: { pictures: [{ file: 'sheet.png' }] } },
      ]),
    ).toEqual([]);
  });

  it('reads a name in the job folder only, never a path out of it', async () => {
    const outer = mkdtempSync(path.join(root, 'outer-'));
    const dir = path.join(outer, 'job');
    mkdirSync(dir);
    writeFileSync(path.join(outer, 'secret.png'), 'secret');
    writeFileSync(path.join(dir, 'sheet.png'), 'sheet');
    // A path out of the folder reads nothing: there is no file of that
    // name inside it.
    expect(
      await picturesOf(dir, [ask('../secret.png'), ask(path.join(outer, 'secret.png'))]),
    ).toEqual([]);
    // With a file of the same name inside, the one inside is sent.
    writeFileSync(path.join(dir, 'secret.png'), 'inside');
    expect(await picturesOf(dir, [ask('../secret.png')])).toEqual([
      { file: '../secret.png', bytes_base64: b64('inside') },
    ]);
  });

  it('stops at the budget: a picture past it is left out and never read, a smaller one after it is sent', async () => {
    const dir = folder();
    // A file of one byte more than the budget, with no bytes on disk.
    writeFileSync(path.join(dir, 'huge.png'), '');
    truncateSync(path.join(dir, 'huge.png'), PARSER_PICTURES_BUDGET_BYTES + 1);
    const sent = await picturesOf(dir, [ask('sheet.png'), ask('huge.png'), ask('right-side.png')]);
    expect(sent.map((p) => p.file)).toEqual(['sheet.png', 'right-side.png']);
  });
});
