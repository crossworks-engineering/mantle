import { describe, expect, it } from 'vitest';

import { evaluate, stateOf, summarise } from './assert';
import type { FixtureExpectation, FixtureResult, ProbeFootprint } from './types';

const healthyRun = {
  traceId: 't1',
  startedAt: '2026-01-01T00:00:00Z',
  status: 'success',
  disposition: null,
  stepNames: ['llm_extract', 'update_index'],
  costMicroUsd: 0,
};

function fp(over: Partial<ProbeFootprint> = {}): ProbeFootprint {
  return {
    nodeId: 'n1',
    exists: true,
    nodeType: 'note',
    summary: 'a real summary',
    embDims: 768,
    hasTsv: true,
    nFacts: 2,
    factKinds: ['episodic'],
    nEntities: 1,
    dupMentionEdges: 0,
    nChunks: 1,
    run: { ...healthyRun },
    ...over,
  };
}

const FULL: FixtureExpectation = {
  trace: { status: 'success' },
  summary: 'present',
  embedding: 'present',
  tsv: 'present',
  facts: 'present',
  graph: 'present',
};

const find = (checks: ReturnType<typeof evaluate>, label: string) => checks.find((c) => c.label === label);
const noFail = (checks: ReturnType<typeof evaluate>) => checks.every((c) => c.status !== 'fail');

describe('evaluate — happy path', () => {
  it('a healthy footprint against FULL has no failing checks', () => {
    const checks = evaluate(FULL, fp());
    expect(noFail(checks)).toBe(true);
    expect(stateOf(fp(), checks)).toBe('ok');
  });
});

describe('evaluate — plumbing', () => {
  it('no terminal run → single Trace fail and stalled state', () => {
    const f = fp({ run: null });
    const checks = evaluate(FULL, f);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ label: 'Trace', status: 'fail' });
    expect(stateOf(f, checks)).toBe('stalled');
  });

  it('an errored run is flagged but evaluation continues', () => {
    const checks = evaluate(FULL, fp({ run: { ...healthyRun, status: 'error' } }));
    expect(find(checks, 'Trace')?.status).toBe('fail');
    // later checks still ran
    expect(find(checks, 'L5 summary')).toBeDefined();
  });
});

describe('evaluate — footprint rules', () => {
  it('wrong embedding dimension fails the 768 check', () => {
    const checks = evaluate(FULL, fp({ embDims: 1536 }));
    expect(find(checks, 'Emb 768')?.status).toBe('fail');
  });

  it('a present-rule fails when the layer is absent', () => {
    expect(find(evaluate(FULL, fp({ summary: null })), 'L5 summary')?.status).toBe('fail');
    expect(find(evaluate(FULL, fp({ hasTsv: false })), 'L5 tsv')?.status).toBe('fail');
    expect(find(evaluate(FULL, fp({ nFacts: 0 })), 'L4 facts')?.status).toBe('fail');
    expect(find(evaluate(FULL, fp({ nEntities: 0 })), 'Graph')?.status).toBe('fail');
  });

  it('an optional rule is reported info, never fail, even when absent', () => {
    const exp: FixtureExpectation = { ...FULL, facts: 'optional', graph: 'optional' };
    const checks = evaluate(exp, fp({ nFacts: 0, nEntities: 0 }));
    expect(find(checks, 'L4 facts')?.status).toBe('info');
    expect(find(checks, 'Graph')?.status).toBe('info');
    expect(noFail(checks)).toBe(true);
  });

  it('an absent rule fails when the layer is unexpectedly present', () => {
    const exp: FixtureExpectation = { ...FULL, summary: 'absent' };
    expect(find(evaluate(exp, fp({ summary: 'leaked' })), 'L5 summary')?.status).toBe('fail');
  });

  it('the consistency rule trips when facts exist but no entity edges do', () => {
    const checks = evaluate(FULL, fp({ nFacts: 3, nEntities: 0 }));
    expect(find(checks, 'Consistency')?.status).toBe('fail');
  });
});

describe('evaluate — trace disposition', () => {
  const skipExpect = (disposition?: string): FixtureExpectation => ({
    ...FULL,
    trace: disposition ? { status: 'skipped', disposition } : { status: 'skipped' },
    summary: 'optional',
    embedding: 'optional',
    facts: 'optional',
    graph: 'optional',
  });

  it('skipped with a matching disposition passes; a mismatch fails', () => {
    const skipped = fp({ run: { ...healthyRun, status: 'skipped', disposition: 'no_text_layer' } });
    expect(find(evaluate(skipExpect('no_text_layer'), skipped), 'Disposition')?.status).toBe('pass');
    expect(find(evaluate(skipExpect('body_too_short'), skipped), 'Disposition')?.status).toBe('fail');
  });

  it('skipped with no pinned disposition accepts any skip reason', () => {
    const skipped = fp({ run: { ...healthyRun, status: 'skipped', disposition: 'body_too_short' } });
    expect(find(evaluate(skipExpect(), skipped), 'Disposition')?.status).toBe('pass');
  });

  it("'either' accepts success or the named skip, but not other skips", () => {
    const exp: FixtureExpectation = { ...FULL, trace: { status: 'either', skipDisposition: 'no_text_layer' }, summary: 'optional', embedding: 'optional', facts: 'optional', graph: 'optional' };
    expect(find(evaluate(exp, fp()), 'Disposition')?.status).toBe('pass'); // success
    const okSkip = fp({ run: { ...healthyRun, status: 'skipped', disposition: 'no_text_layer' } });
    expect(find(evaluate(exp, okSkip), 'Disposition')?.status).toBe('pass');
    const badSkip = fp({ run: { ...healthyRun, status: 'skipped', disposition: 'type_not_in_allowlist' } });
    expect(find(evaluate(exp, badSkip), 'Disposition')?.status).toBe('fail');
  });
});

describe('summarise', () => {
  it('counts only ok states as passed', () => {
    const results = [{ state: 'ok' }, { state: 'fail' }, { state: 'ok' }, { state: 'stalled' }] as unknown as FixtureResult[];
    expect(summarise(results)).toEqual({ passed: 2, total: 4 });
  });
});
