/**
 * The job `pipelineRun` checks and sends the JSON form of a step's result
 * (./pipeline-job.ts), as the old path's out.json was JSON: a number cell
 * that is not finite, and a cell that is undefined, is null, and the result
 * stands. A result JSON cannot hold is a refused result, `failed`.
 * The step is the test-only package (pkg/test-echo), run in this process.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PIPELINE_API } from '@mantle/files/pipelines/contract';
import { JobFailure } from './job-failure';
import { jobPaths } from './jobs';
import { jsonOf, runPipelineJob } from './pipeline-job';

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
      240_000,
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
});
