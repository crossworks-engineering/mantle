import { describe, expect, it } from 'vitest';
import { ASSISTANT_TURN_MAX_CHARS, longMessageNoteTitle } from './assistant-limits';

describe('ASSISTANT_TURN_MAX_CHARS', () => {
  it('is the number the turn route validates against', () => {
    // Pinned deliberately: the composer offloads at this number and the route
    // rejects above it. If they ever drift, a long paste 400s again.
    expect(ASSISTANT_TURN_MAX_CHARS).toBe(20_000);
  });
});

describe('longMessageNoteTitle', () => {
  it('uses the first non-empty line', () => {
    expect(longMessageNoteTitle('Feature Upgrade Roadmap\n\nbody text')).toBe(
      'Feature Upgrade Roadmap',
    );
  });

  it('skips leading blank lines', () => {
    expect(longMessageNoteTitle('\n\n   \nThe actual title\nmore')).toBe('The actual title');
  });

  it('strips markdown heading, bullet and ordered-item punctuation', () => {
    expect(longMessageNoteTitle('### Phase 2 — Size S/L')).toBe('Phase 2 — Size S/L');
    expect(longMessageNoteTitle('- a bulleted opener')).toBe('a bulleted opener');
    expect(longMessageNoteTitle('> quoted opener')).toBe('quoted opener');
    expect(longMessageNoteTitle('1. first step')).toBe('first step');
  });

  it('skips a bare code fence and takes the line after it', () => {
    expect(longMessageNoteTitle('```json\n{"a":1}')).toBe('{"a":1}');
  });

  it('truncates to the notes API title limit with an ellipsis', () => {
    const title = longMessageNoteTitle('x'.repeat(500));
    expect(title).toHaveLength(200);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps a title exactly at the limit intact', () => {
    expect(longMessageNoteTitle('y'.repeat(200))).toBe('y'.repeat(200));
  });

  it('falls back when there is no usable line', () => {
    expect(longMessageNoteTitle('')).toBe('Long message');
    expect(longMessageNoteTitle('\n\n  \n')).toBe('Long message');
    expect(longMessageNoteTitle('```', 'Pasted text')).toBe('Pasted text');
  });
});
