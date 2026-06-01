/**
 * Compare an expectation against a footprint → tiered checks.
 *
 * Tiers (in evaluation order):
 *   1. Plumbing      — did an extractor_run fire and terminate?
 *   2. Disposition   — is the terminal status/disposition the expected one?
 *   3. Footprint     — are the expected layers populated to spec (incl. 768 dims)?
 *   4. Consistency   — cross-layer sanity (edge count vs entities).
 *
 * A `present`/`absent` rule that's violated is a `fail`; an `optional` rule is
 * reported as `info` (shown, never red). The overall state is `fail` if any
 * check failed, `stalled` if the run never terminated, else `ok`.
 */
import type { CheckResult, FixtureExpectation, FixtureResult, FixtureState, LayerRule, ProbeFootprint } from './types';
import { EXPECTED_DIMS } from './footprint';

function ruleCheck(label: string, rule: LayerRule, actual: boolean, detail: string): CheckResult {
  if (rule === 'optional') return { label, status: 'info', detail };
  const want = rule === 'present';
  return { label, status: actual === want ? 'pass' : 'fail', detail };
}

export function evaluate(expect: FixtureExpectation, fp: ProbeFootprint): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1. Plumbing — an extractor_run must have terminated.
  if (!fp.run) {
    checks.push({
      label: 'Trace',
      status: 'fail',
      detail: 'no terminal extractor_run — is apps/agent running and an extractor worker configured?',
    });
    return checks; // nothing else is meaningful without a run
  }
  if (fp.run.status === 'error') {
    checks.push({ label: 'Trace', status: 'fail', detail: `extractor_run errored` });
  }

  // 2. Disposition — status/skip matches expectation.
  const exp = expect.trace;
  let traceOk = true;
  let traceDetail = `status=${fp.run.status}${fp.run.disposition ? ` (${fp.run.disposition})` : ''}`;
  if (exp.status === 'success') {
    traceOk = fp.run.status === 'success';
    if (!traceOk) traceDetail += ' · expected success';
  } else if (exp.status === 'skipped') {
    traceOk = fp.run.status === 'skipped' && (!exp.disposition || fp.run.disposition === exp.disposition);
    if (!traceOk) traceDetail += ` · expected skipped${exp.disposition ? `:${exp.disposition}` : ''}`;
  } else {
    // 'either' — success, or a skip with the named disposition.
    if (fp.run.status === 'success') traceOk = true;
    else if (fp.run.status === 'skipped')
      traceOk = !exp.skipDisposition || fp.run.disposition === exp.skipDisposition;
    else traceOk = false;
    if (!traceOk) traceDetail += ` · expected success or skipped:${exp.skipDisposition ?? '*'}`;
  }
  checks.push({ label: 'Disposition', status: traceOk ? 'pass' : 'fail', detail: traceDetail });

  // If the node was (legitimately or not) skipped, the layer rules below only
  // bite when they were declared 'present'. Optional rules stay info.
  // 3. Footprint.
  checks.push(ruleCheck('L5 summary', expect.summary, !!fp.summary, fp.summary ? `“${fp.summary.slice(0, 60)}”` : 'empty'));

  const hasEmb = fp.embDims != null;
  checks.push(ruleCheck('L5 embedding', expect.embedding, hasEmb, hasEmb ? `${fp.embDims}-dim` : 'none'));
  if (hasEmb && expect.embedding !== 'absent') {
    checks.push({
      label: `Emb ${EXPECTED_DIMS}`,
      status: fp.embDims === EXPECTED_DIMS ? 'pass' : 'fail',
      detail: `${fp.embDims} dims${fp.embDims === EXPECTED_DIMS ? '' : ` · expected ${EXPECTED_DIMS}`}`,
    });
  }

  checks.push(ruleCheck('L5 tsv', expect.tsv, fp.hasTsv, fp.hasTsv ? 'set' : 'missing'));
  checks.push(
    ruleCheck('L4 facts', expect.facts, fp.nFacts > 0, `${fp.nFacts}${fp.factKinds.length ? ` (${fp.factKinds.join(',')})` : ''}`),
  );
  checks.push(ruleCheck('Graph', expect.graph, fp.nEntities > 0, `${fp.nEntities} mentioned_in`));

  // 4. Consistency — only assert when both layers were expected present.
  if (expect.facts === 'present' && expect.graph === 'present' && fp.nFacts > 0 && fp.nEntities === 0) {
    checks.push({ label: 'Consistency', status: 'fail', detail: 'facts present but 0 entity edges' });
  }

  return checks;
}

/** Roll the checks into a single fixture state. */
export function stateOf(fp: ProbeFootprint | null, checks: CheckResult[]): FixtureState {
  if (fp && !fp.run) return 'stalled';
  return checks.some((c) => c.status === 'fail') ? 'fail' : 'ok';
}

export function summarise(results: FixtureResult[]): { passed: number; total: number } {
  return {
    passed: results.filter((r) => r.state === 'ok').length,
    total: results.length,
  };
}
