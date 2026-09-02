import { describe, expect, it } from 'vitest';
import {
  MAX_TOOL_CALLS_PER_RESPONSE,
  NO_PROGRESS_LIMIT,
  REPEATED_FAILURE_LIMIT,
  TurnGuards,
  canonicalJson,
  resolveCap,
} from './guards';

const call = (id: string, slug = 'page_get', argsRaw = '{"id":"x"}') => ({ id, slug, argsRaw });

describe('resolveCap / canonicalJson', () => {
  it('clamps overrides and falls back on junk', () => {
    expect(resolveCap(undefined, 40, 200)).toBe(40);
    expect(resolveCap(0, 40, 200)).toBe(40);
    expect(resolveCap(12.9, 40, 200)).toBe(12);
    expect(resolveCap(999, 40, 200)).toBe(200);
  });
  it('canonicalises key order and nesting', () => {
    expect(canonicalJson({ b: 2, a: { d: 1, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":1},"b":2}',
    );
  });
});

describe('TurnGuards', () => {
  const make = () => new TurnGuards({ maxToolCallsPerTurn: 4, maxCallsPerToolPerTurn: 2 });

  it('lets a fresh call through and counts it on admit', () => {
    const g = make();
    g.beginBatch();
    expect(g.preParse(call('c1'))).toBeNull();
    expect(g.postParse('page_get', 'page_get::{"id":"x"}')).toBeNull();
    g.admit('page_get');
    expect(g.totalToolCalls).toBe(1);
    expect(g.dispatchedThisBatch).toBe(1);
  });

  it('suppresses a byte-identical duplicate within one response, pointing at the first call', () => {
    const g = make();
    g.beginBatch();
    expect(g.preParse(call('c1'))).toBeNull();
    const v = g.preParse(call('c2'));
    expect(v?.reason).toBe('duplicate_in_response');
    expect(v?.firstCallId).toBe('c1');
    // a new batch forgets the signature (a cross-round repeat is legitimate)
    g.beginBatch();
    expect(g.preParse(call('c3'))).toBeNull();
  });

  it('caps non-duplicate calls per response', () => {
    const g = new TurnGuards({ maxToolCallsPerTurn: 500, maxCallsPerToolPerTurn: 500 });
    g.beginBatch();
    for (let i = 0; i < MAX_TOOL_CALLS_PER_RESPONSE; i++) {
      expect(g.preParse(call(`c${i}`, 'note_create', `{"n":${i}}`))).toBeNull();
    }
    expect(g.preParse(call('cx', 'note_create', '{"n":"last"}'))?.reason).toBe(
      'too_many_calls_in_response',
    );
  });

  it('enforces the same-tool cap against the BATCH-START snapshot, so a batch that starts under it runs in full', () => {
    const g = make(); // 2 per tool
    g.beginBatch();
    for (const id of ['a', 'b', 'c']) {
      expect(g.preParse(call(id, 'page_get', `{"id":"${id}"}`))).toBeNull();
      g.admit('page_get');
    }
    expect(g.totalToolCalls).toBe(3);
    g.beginBatch();
    const v = g.preParse(call('d', 'page_get', '{"id":"d"}'));
    expect(v?.reason).toBe('tool_repeat_limit');
    expect(v?.note).toContain("called 'page_get' 3 times");
  });

  it('spends the turn budget only at the batch boundary', () => {
    const g = make(); // budget 4
    g.beginBatch();
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(g.preParse(call(id, 'note_create', `{"t":"${id}"}`))).toBeNull();
      g.admit('note_create');
    }
    expect(g.budgetExhausted).toBe(false);
    expect(g.endBatch(5)).toBe('budget_exhausted');
    g.beginBatch();
    expect(g.preParse(call('f', 'note_create', '{"t":"f"}'))?.reason).toBe(
      'turn_tool_budget_reached',
    );
  });

  it('blocks a call that keeps failing identically, at the limit', () => {
    const g = make();
    const sig = 'web_fetch::{"url":"x"}';
    for (let i = 0; i < REPEATED_FAILURE_LIMIT - 1; i++) g.recordFailure(sig);
    expect(g.postParse('web_fetch', sig)).toBeNull();
    expect(g.recordFailure(sig)).toBe(REPEATED_FAILURE_LIMIT);
    expect(g.postParse('web_fetch', sig)?.reason).toBe('repeated_failure');
  });

  it('blocks a call that returns the identical result N times, and a changed result resets the streak', () => {
    const g = make();
    const sig = 'page_get::{"id":"x"}';
    for (let i = 0; i < NO_PROGRESS_LIMIT; i++) g.recordResult(sig, '{"same":true}');
    expect(g.postParse('page_get', sig)?.reason).toBe('no_progress');
    g.recordResult(sig, '{"same":false}');
    expect(g.postParse('page_get', sig)).toBeNull();
  });

  it('flags a batch of 3+ that was entirely skipped, but not a lone skipped call', () => {
    const g = make();
    g.beginBatch();
    expect(g.endBatch(3)).toBe('batch_fully_skipped');
    g.beginBatch();
    expect(g.endBatch(1)).toBeNull();
  });
});
