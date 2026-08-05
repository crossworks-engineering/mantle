import { describe, expect, it } from 'vitest';
import { liveTrailView } from './thought-trail-view';
import type { ThoughtEvent } from './use-turn-stream';

const step = (label: string, over: Partial<ThoughtEvent> = {}): ThoughtEvent => ({
  kind: 'tool',
  label,
  ...over,
});

describe('liveTrailView', () => {
  it('with no narration: past is everything but the active step, no narration slot', () => {
    const steps = [step('a'), step('b'), step('c')];
    const { past, active, lastNarrated } = liveTrailView(steps, 'list');
    expect(active.label).toBe('c');
    expect(past.map((s) => s.label)).toEqual(['a', 'b']);
    // The MANTLE_TURN_NARRATION=0 shape — grounded lines only, empty slot.
    expect(lastNarrated).toBeNull();
  });

  it('promotes the newest narrated step to the slot and out of the stack', () => {
    const narrated = step('Let me dig through your notes…', { narrated: true });
    const steps = [step('a'), narrated, step('b')];
    const { past, lastNarrated } = liveTrailView(steps, 'list');
    expect(lastNarrated).toBe(narrated);
    expect(past.map((s) => s.label)).toEqual(['a']);
  });

  it('a newer narration supersedes the older one, which returns to the stack', () => {
    const older = step('First narration…', { narrated: true });
    const newer = step('Second narration…', { narrated: true });
    const steps = [older, step('a'), newer, step('b')];
    const { past, lastNarrated } = liveTrailView(steps, 'list');
    expect(lastNarrated).toBe(newer);
    expect(past).toContain(older);
  });

  it('skips a narrated step whose label is already the active footer line', () => {
    const steps = [step('a'), step('On it…', { narrated: true })];
    const { lastNarrated, active } = liveTrailView(steps, 'list');
    expect(active.label).toBe('On it…');
    expect(lastNarrated).toBeNull();
  });

  it('replace mode drops grounded history but keeps narrated rows', () => {
    const older = step('First narration…', { narrated: true });
    const newer = step('Second narration…', { narrated: true });
    const steps = [older, step('a'), newer, step('b'), step('c')];
    const { past, lastNarrated } = liveTrailView(steps, 'replace');
    expect(lastNarrated).toBe(newer);
    // Grounded a/b are pruned; the superseded narration survives.
    expect(past).toEqual([older]);
  });

  it('replace mode with no narration shows only the active line', () => {
    const steps = [step('a'), step('b')];
    const { past, lastNarrated } = liveTrailView(steps, 'replace');
    expect(past).toEqual([]);
    expect(lastNarrated).toBeNull();
  });
});
