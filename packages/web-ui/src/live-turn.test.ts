import { describe, expect, it } from 'vitest';
import { applyLiveTurnEvent, emptyLiveTurn, type LiveTurn } from './live-turn';

describe('applyLiveTurnEvent', () => {
  it('routes a plain status to `status`, leaving narration alone', () => {
    const l = applyLiveTurnEvent(
      { ...emptyLiveTurn('t'), narration: 'Let me check your notes…' },
      { type: 'status', data: { label: 'Searching the web…' } },
    );
    expect(l.status).toBe('Searching the web…');
    expect(l.narration).toBe('Let me check your notes…');
  });

  it('routes a narrated status to `narration`, leaving the grounded status alone', () => {
    const l = applyLiveTurnEvent(
      { ...emptyLiveTurn('t'), status: 'Searching the web…' },
      { type: 'status', data: { label: 'Checking the web for you…', narrated: true } },
    );
    expect(l.narration).toBe('Checking the web for you…');
    expect(l.status).toBe('Searching the web…');
  });

  it('a later plain status never clears narration', () => {
    let l = emptyLiveTurn('t');
    l = applyLiveTurnEvent(l, { type: 'status', data: { label: 'On it…', narrated: true } });
    l = applyLiveTurnEvent(l, { type: 'status', data: { label: 'Reading a file…' } });
    expect(l.narration).toBe('On it…');
    expect(l.status).toBe('Reading a file…');
  });

  it('accumulates reasoning deltas', () => {
    let l = emptyLiveTurn('t');
    l = applyLiveTurnEvent(l, { type: 'reasoning-delta', data: { text: 'The user wants ' } });
    l = applyLiveTurnEvent(l, { type: 'reasoning-delta', data: { text: 'a summary.' } });
    expect(l.reasoning).toBe('The user wants a summary.');
  });

  it('text deltas append and clear the grounded status (narration persists)', () => {
    let l: LiveTurn = { ...emptyLiveTurn('t'), narration: 'Writing this up…' };
    l = applyLiveTurnEvent(l, { type: 'text-delta', data: { text: 'Hello' } });
    l = applyLiveTurnEvent(l, { type: 'text-delta', data: { text: ' world' } });
    expect(l.text).toBe('Hello world');
    expect(l.status).toBeNull();
    expect(l.narration).toBe('Writing this up…');
  });

  it('ignores unhandled event types', () => {
    const before = emptyLiveTurn('t');
    expect(applyLiveTurnEvent(before, { type: 'tool-start', data: {} })).toBe(before);
  });
});
