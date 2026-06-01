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

import { SPECS, SPEC_BY_KEY, SERVICE_INDEXED, SERVICE_SKIP, type FixtureSpec } from './spec';
import { waitForExtractor } from './footprint';
import { evaluate, summarise } from './assert';
import { runUpdate, runDelete } from './lifecycle';
import { resolveCapabilities } from './capabilities';
import {
  PROBE_BASE_TAG,
  probeRunTag,
  type Capabilities,
  type CheckResult,
  type FixtureExpectation,
  type FixtureState,
  type FixtureResult,
  type SuiteReport,
} from './types';

/** Resolve a spec's concrete expectation — gating optional-service rows on the
 *  live capability snapshot (Phase 2e). */
function expectationFor(spec: FixtureSpec, caps: Capabilities): FixtureExpectation {
  if (!spec.service) return spec.expect;
  const available = spec.service === 'tika' ? caps.tika.available : caps.vision.available;
  return available ? SERVICE_INDEXED : SERVICE_SKIP;
}

export type RunOptions = {
  /** Restrict to these fixture keys; empty/undefined = all. */
  only?: string[];
  /** Per-fixture extractor wait budget. */
  timeoutMs?: number;
  /** Also edit each fixture and assert it re-extracts (where an updater exists). */
  includeUpdate?: boolean;
  /** Also delete each fixture and assert the kind-aware reapers fire. */
  includeDelete?: boolean;
};

/** Roll all check groups into one state. */
function rollup(base: ProbeRun, extra: CheckResult[][]): FixtureState {
  if (base.fp && !base.fp.run) return 'stalled';
  const all = [...base.checks, ...extra.flat()];
  return all.some((c) => c.status === 'fail') ? 'fail' : 'ok';
}

type ProbeRun = { fp: import('./types').ProbeFootprint | null; checks: CheckResult[] };

export async function runIntegritySuite(ownerId: string, opts: RunOptions = {}): Promise<SuiteReport> {
  const runId = randomBytes(4).toString('hex');
  const runTag = probeRunTag(runId);
  const tags = [PROBE_BASE_TAG, runTag];
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const specs = opts.only?.length ? opts.only.map((k) => SPEC_BY_KEY.get(k)).filter(Boolean) as typeof SPECS : SPECS;

  const startedAt = new Date();
  const capabilities = await resolveCapabilities(ownerId);
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
      const checks = evaluate(expectationFor(spec, capabilities), fp);

      let updateChecks: CheckResult[] | undefined;
      let deleteChecks: CheckResult[] | undefined;
      let deleted = false;
      let cost = fp.run?.costMicroUsd ?? 0;
      // Only run lifecycle sub-tests when the base run actually settled.
      if (fp.run) {
        let current = fp;
        if (opts.includeUpdate && spec.update) {
          const up = await runUpdate(ownerId, spec, { ownerId, tags, runId }, built.nodeId, current, timeoutMs);
          updateChecks = up.checks;
          current = up.after;
          cost += up.after.run?.traceId !== fp.run.traceId ? up.after.run?.costMicroUsd ?? 0 : 0;
        }
        if (opts.includeDelete) {
          const del = await runDelete(ownerId, spec, built.nodeId, current);
          deleteChecks = del.checks;
          deleted = true;
        }
      }

      results.push({
        key: spec.key,
        label: spec.label,
        nodeType: spec.nodeType,
        state: rollup({ fp, checks }, [updateChecks ?? [], deleteChecks ?? []]),
        nodeId: built.nodeId,
        footprint: fp,
        checks,
        updateChecks,
        deleteChecks,
        deleted,
        costMicroUsd: cost,
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
    capabilities,
  };
}
