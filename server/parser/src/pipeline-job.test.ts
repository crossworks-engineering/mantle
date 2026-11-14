/**
 * The job `pipelineRun` checks and sends the JSON form of a step's result
 * (./pipeline-job.ts), as the old path's out.json was JSON: a number cell
 * that is not finite, and a cell that is undefined, is null, and the result
 * stands. A result JSON cannot hold is a refused result, `failed`. A result
 * over the answer cap is `too_large`, final, before its text is parsed.
 * The step is the test-only package (pkg/test-echo), run in this process.
 * The CAD tier's children get the time left to the handle's deadline, not
 * the whole job time (the CAD tier is faked here: no Python).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PIPELINE_API } from '@mantle/files/pipelines/contract';
import { JobFailure } from './job-failure';
import { jobPaths } from './jobs';
import { jobHandle, jsonOf, runPipelineJob } from './pipeline-job';
import { PICTURES_RESERVE_MS } from './pictures';

/** The time each faked child of the CAD tier was given. */
const given = vi.hoisted(() => ({ dwg: [] as number[], dwf: [] as number[] }));
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
  it('cadRender and dwfRender get the time to the handle deadline, at the call', async () => {
    const p = jobPaths(mkdtempSync(path.join(root, 'job-')));
    writeFileSync(p.input, 'x');
    const left = 60_000;
    const job = jobHandle(p, Date.now() + PICTURES_RESERVE_MS + left);
    expect(await job.cadRender({})).toEqual({});
    await job.dwfRender(Buffer.from('x'), { dpi: 100 });
    for (const ms of [...given.dwg, ...given.dwf]) {
      expect(ms).toBeLessThanOrEqual(left);
      expect(ms).toBeGreaterThan(left - 5_000);
    }
    expect([given.dwg.length, given.dwf.length]).toEqual([1, 1]);
  });
});
