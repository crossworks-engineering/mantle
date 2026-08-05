import { describe, expect, it } from 'vitest';
import { canReplaceInFlightTurn, combineCorrectedPrompt } from './replace-turn';

/** A gate input that passes — each test flips one field off it. */
const eligible = {
  streamingOn: true,
  sending: true,
  stopping: false,
  activeTurnId: 'turn-1',
  hasAttachment: false,
  lastTurnHadFile: false,
};

describe('canReplaceInFlightTurn', () => {
  it('allows the replace on the happy path (streaming, text-only, in flight)', () => {
    expect(canReplaceInFlightTurn(eligible)).toBe(true);
  });

  it('never engages in blocking mode — there is no cancel primitive there', () => {
    expect(canReplaceInFlightTurn({ ...eligible, streamingOn: false })).toBe(false);
  });

  it('requires an in-flight turn (sending + a live turn id)', () => {
    expect(canReplaceInFlightTurn({ ...eligible, sending: false })).toBe(false);
    expect(canReplaceInFlightTurn({ ...eligible, activeTurnId: null })).toBe(false);
  });

  it('defers to a plain Stop already in flight', () => {
    expect(canReplaceInFlightTurn({ ...eligible, stopping: true })).toBe(false);
  });

  it("keeps today's behaviour when either side of the pair carries a file", () => {
    expect(canReplaceInFlightTurn({ ...eligible, hasAttachment: true })).toBe(false);
    expect(canReplaceInFlightTurn({ ...eligible, lastTurnHadFile: true })).toBe(false);
  });
});

describe('combineCorrectedPrompt', () => {
  it('joins original + correction with a newline, verbatim', () => {
    expect(combineCorrectedPrompt('book flights to CPT', 'for the 14th, not the 4th')).toBe(
      'book flights to CPT\nfor the 14th, not the 4th',
    );
  });

  it('degrades to whichever side is non-empty', () => {
    expect(combineCorrectedPrompt('', 'just this')).toBe('just this');
    expect(combineCorrectedPrompt('just this', '')).toBe('just this');
  });
});
