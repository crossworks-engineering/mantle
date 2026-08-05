import { describe, expect, it } from 'vitest';
import { applyStatusToTrail, type ThoughtEvent } from './use-turn-stream';

const grounded = (over: Partial<ThoughtEvent> = {}): ThoughtEvent => ({
  stepId: '1',
  kind: 'brain',
  label: 'Searching your brain for “cars”…',
  elapsedMs: 100,
  ...over,
});

describe('applyStatusToTrail', () => {
  it('appends a new step', () => {
    const out = applyStatusToTrail([], grounded());
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('Searching your brain for “cars”…');
  });

  it('upserts a narrated upgrade in place, preserving elapsedMs and setting narrated', () => {
    const trail = [grounded()];
    const out = applyStatusToTrail(
      trail,
      grounded({ label: 'Let me dig through your notes on cars…', narrated: true, elapsedMs: 900 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('Let me dig through your notes on cars…');
    expect(out[0]!.narrated).toBe(true);
    // The step started when its grounded line arrived — the upgrade keeps that.
    expect(out[0]!.elapsedMs).toBe(100);
  });

  it('keeps narrated on a step once set (identical re-delivery is a no-op)', () => {
    const one = applyStatusToTrail(
      [grounded()],
      grounded({ label: 'On it…', narrated: true, elapsedMs: 500 }),
    );
    const two = applyStatusToTrail(
      one,
      grounded({ label: 'On it…', narrated: true, elapsedMs: 600 }),
    );
    expect(two).toBe(one); // same reference — nothing changed
    expect(two[0]!.narrated).toBe(true);
  });

  it('upserts a late narrated event onto its row even after later steps appended', () => {
    const trail = [grounded(), grounded({ stepId: '2', label: 'Working on it…', elapsedMs: 300 })];
    const out = applyStatusToTrail(
      trail,
      grounded({ label: 'Let me dig through your notes on cars…', narrated: true }),
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.narrated).toBe(true);
    expect(out[1]!.narrated).toBeUndefined();
  });

  it('collapses a consecutive duplicate append', () => {
    const trail = [grounded({ stepId: undefined })];
    const out = applyStatusToTrail(trail, grounded({ stepId: undefined, elapsedMs: 400 }));
    expect(out).toBe(trail);
  });

  it('does NOT swallow a narrated line identical in text to the previous grounded one', () => {
    const trail = [grounded({ stepId: undefined })];
    const out = applyStatusToTrail(trail, grounded({ stepId: undefined, narrated: true }));
    expect(out).toHaveLength(2);
    expect(out[1]!.narrated).toBe(true);
  });
});
