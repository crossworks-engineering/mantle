import { describe, expect, it } from 'vitest';

import { evaluateLanded, EXPECTED_DIMS, STALL_MS } from './evaluate-landed';
import type { ProbeFootprint } from '@mantle/web-ui/types/integrity';

/** A footprint with sensible "fully indexed" defaults; override per case. */
function fp(over: Partial<ProbeFootprint> = {}): ProbeFootprint {
  return {
    nodeId: 'n1',
    exists: true,
    nodeType: 'note',
    summary: 'A summary',
    embDims: EXPECTED_DIMS,
    hasTsv: true,
    nFacts: 2,
    factKinds: ['factual'],
    nEntities: 1,
    dupMentionEdges: 0,
    nChunks: 1,
    run: {
      traceId: 't1',
      startedAt: '2026-06-02T00:00:00Z',
      status: 'success',
      disposition: null,
      stepNames: ['llm_extract', 'embed_batch'],
      costMicroUsd: 0,
    },
    ...over,
  };
}

const fail = (cs: ReturnType<typeof evaluateLanded>['checks']) =>
  cs.filter((c) => c.status === 'fail');

describe('evaluateLanded', () => {
  it('ok when success + summary + 768-dim embedding + tsv all present', () => {
    const r = evaluateLanded(fp(), 1000);
    expect(r.state).toBe('ok');
    expect(fail(r.checks)).toHaveLength(0);
  });

  it('indexing while young with no terminal run', () => {
    const r = evaluateLanded(fp({ run: null }), 1000);
    expect(r.state).toBe('indexing');
  });

  it('stalled once past the stall window with no run', () => {
    const r = evaluateLanded(fp({ run: null }), STALL_MS + 1);
    expect(r.state).toBe('stalled');
    expect(fail(r.checks)).toHaveLength(1);
  });

  it('fail on an errored run', () => {
    const r = evaluateLanded(fp({ run: { ...fp().run!, status: 'error' } }), 1000);
    expect(r.state).toBe('fail');
  });

  it('skipped reads neutral and surfaces the disposition (not red)', () => {
    const r = evaluateLanded(
      fp({
        summary: null,
        embDims: null,
        hasTsv: false,
        run: { ...fp().run!, status: 'skipped', disposition: 'no_text_layer' },
      }),
      1000,
    );
    expect(r.state).toBe('skipped');
    expect(fail(r.checks)).toHaveLength(0);
    expect(r.checks[0]?.detail).toContain('no_text_layer');
  });

  it('fail: success but no summary (silent miss)', () => {
    const r = evaluateLanded(fp({ summary: null }), 1000);
    expect(r.state).toBe('fail');
    expect(fail(r.checks).some((c) => c.label === 'L5 summary')).toBe(true);
  });

  it('fail: success but missing embedding', () => {
    const r = evaluateLanded(fp({ embDims: null }), 1000);
    expect(r.state).toBe('fail');
    expect(fail(r.checks).some((c) => c.label === 'L5 embedding')).toBe(true);
  });

  it('fail: embedding dimension drift (not 768)', () => {
    const r = evaluateLanded(fp({ embDims: 1536 }), 1000);
    expect(r.state).toBe('fail');
    expect(fail(r.checks).some((c) => c.label === `Emb ${EXPECTED_DIMS}`)).toBe(true);
  });

  it('fail: duplicate mentioned_in edges', () => {
    const r = evaluateLanded(fp({ dupMentionEdges: 3 }), 1000);
    expect(r.state).toBe('fail');
    expect(fail(r.checks).some((c) => c.label === 'Dup edges')).toBe(true);
  });

  it('facts + graph are informational, never red on absence', () => {
    const r = evaluateLanded(fp({ nFacts: 0, factKinds: [], nEntities: 0 }), 1000);
    expect(r.state).toBe('ok');
    const facts = r.checks.find((c) => c.label === 'L4 facts');
    const graph = r.checks.find((c) => c.label === 'Graph');
    expect(facts?.status).toBe('info');
    expect(graph?.status).toBe('info');
  });
});
