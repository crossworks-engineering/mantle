/**
 * The suite runner. Synchronous server-side: for each fixture it creates the
 * node (via the canonical write path), waits for the extractor to settle, and
 * asserts the footprint. Fixtures run sequentially so we don't stampede the
 * local extractor; with local models a full pass is fast and ~free.
 *
 * Cost is summed from the extractor_run traces — with the local gemma + local
 * embedder it should read ≈ $0. A non-zero total means a fixture unexpectedly
 * hit a cloud model, which the report surfaces.
 */
import { randomBytes } from 'node:crypto';

import { SPECS, SPEC_BY_KEY } from './spec';
import { waitForExtractor } from './footprint';
import { evaluate, stateOf, summarise } from './assert';
import { PROBE_BASE_TAG, probeRunTag, type FixtureResult, type SuiteReport } from './types';

export type RunOptions = {
  /** Restrict to these fixture keys; empty/undefined = all. */
  only?: string[];
  /** Per-fixture extractor wait budget. */
  timeoutMs?: number;
};

export async function runIntegritySuite(ownerId: string, opts: RunOptions = {}): Promise<SuiteReport> {
  const runId = randomBytes(4).toString('hex');
  const runTag = probeRunTag(runId);
  const tags = [PROBE_BASE_TAG, runTag];
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const specs = opts.only?.length ? opts.only.map((k) => SPEC_BY_KEY.get(k)).filter(Boolean) as typeof SPECS : SPECS;

  const startedAt = new Date();
  const results: FixtureResult[] = [];

  for (const spec of specs) {
    const t0 = Date.now();
    try {
      const built = await spec.build({ ownerId, tags, runId });
      if ('missing' in built) {
        results.push({
          key: spec.key,
          label: spec.label,
          nodeType: spec.nodeType,
          state: 'missing',
          nodeId: null,
          footprint: null,
          checks: [{ label: 'Fixture', status: 'info', detail: built.reason }],
          costMicroUsd: 0,
          durationMs: Date.now() - t0,
        });
        continue;
      }

      const fp = await waitForExtractor(ownerId, built.nodeId, timeoutMs);
      const checks = evaluate(spec.expect, fp);
      results.push({
        key: spec.key,
        label: spec.label,
        nodeType: spec.nodeType,
        state: stateOf(fp, checks),
        nodeId: built.nodeId,
        footprint: fp,
        checks,
        costMicroUsd: fp.run?.costMicroUsd ?? 0,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      results.push({
        key: spec.key,
        label: spec.label,
        nodeType: spec.nodeType,
        state: 'error',
        nodeId: null,
        footprint: null,
        checks: [{ label: 'Build', status: 'fail', detail: err instanceof Error ? err.message : String(err) }],
        costMicroUsd: 0,
        durationMs: Date.now() - t0,
      });
    }
  }

  const finishedAt = new Date();
  const { passed, total } = summarise(results);
  return {
    runId,
    runTag,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    totalCostMicroUsd: results.reduce((s, r) => s + r.costMicroUsd, 0),
    passed,
    total,
    results,
  };
}
