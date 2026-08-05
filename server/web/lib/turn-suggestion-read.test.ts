import { describe, expect, it } from 'vitest';
import { suggestionPayload } from './turn-suggestion-read';

describe('suggestionPayload', () => {
  it('204-shape (null) before the suggester has written anything', () => {
    expect(suggestionPayload({})).toBeNull();
    expect(suggestionPayload({ thoughts: [{ kind: 'thinking', label: 'x' }] })).toBeNull();
  });

  // Covers a cross-owner or unknown turnId: the owner-scoped query returns no
  // row, which must be indistinguishable from "no suggestion yet".
  it('204-shape (null) when the owner-scoped query found no row', () => {
    expect(suggestionPayload(null)).toBeNull();
    expect(suggestionPayload(undefined)).toBeNull();
  });

  it('200 payload once the suggestion is on the row', () => {
    expect(
      suggestionPayload({
        suggestion: 'What about the edge cases?',
        suggestedAt: '2026-08-02T10:00:00Z',
      }),
    ).toEqual({ suggestion: 'What about the edge cases?', suggestedAt: '2026-08-02T10:00:00Z' });
  });

  it('tolerates junk in the jsonb without leaking it', () => {
    expect(suggestionPayload({ suggestion: 42 })).toBeNull();
    expect(suggestionPayload({ suggestion: '   ' })).toBeNull();
    expect(suggestionPayload({ suggestion: 'ok then?', suggestedAt: 99 })).toEqual({
      suggestion: 'ok then?',
    });
    expect(suggestionPayload('a string')).toBeNull();
  });
});
