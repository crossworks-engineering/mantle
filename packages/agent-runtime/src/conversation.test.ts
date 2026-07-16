import { describe, expect, it } from 'vitest';
import { looksAnaphoricFollowup } from './conversation';

describe('looksAnaphoricFollowup', () => {
  it('flags short referential follow-ups (enrich the retrieval embedding)', () => {
    for (const q of [
      'tell me more about that',
      'what about it?',
      'continue',
      'the lister one',
      'how about those',
      'go on',
    ]) {
      expect(looksAnaphoricFollowup(q)).toBe(true);
    }
  });

  it('leaves clear standalone queries alone (no dilution)', () => {
    for (const q of [
      'my bank balance',
      'when does my car licence expire',
      'who does Cross Works bank with',
      'what is the capital of France', // long enough + no referent
      '',
    ]) {
      expect(looksAnaphoricFollowup(q)).toBe(false);
    }
  });

  it('requires BOTH short AND referential', () => {
    // referential but long → not treated as a bare follow-up
    expect(
      looksAnaphoricFollowup(
        'I was reading about that printer gantry rebuild plan in detail today',
      ),
    ).toBe(false);
    // short but no referent
    expect(looksAnaphoricFollowup('sermon notes')).toBe(false);
  });
});
