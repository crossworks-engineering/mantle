import { describe, expect, it } from 'vitest';
import { deriveTitle } from './journal';

describe('deriveTitle', () => {
  it('takes the first sentence when the body has several', () => {
    expect(deriveTitle('I started a new job today. It feels great so far.')).toBe(
      'I started a new job today.',
    );
  });

  it('keeps a short single sentence verbatim, collapsing whitespace', () => {
    expect(deriveTitle('  multiple   spaces\n  here  ')).toBe('multiple spaces here');
  });

  it('falls back to "Journal entry" for empty / whitespace-only bodies', () => {
    expect(deriveTitle('')).toBe('Journal entry');
    expect(deriveTitle('   \n  ')).toBe('Journal entry');
  });

  it('truncates a long first sentence (>60 chars) with an ellipsis', () => {
    const long = 'a'.repeat(80);
    const out = deriveTitle(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(58); // 57 chars + ellipsis
  });

  it('prefers the first sentence even when later sentences are long', () => {
    const body = `Short one. ${'x'.repeat(200)}`;
    expect(deriveTitle(body)).toBe('Short one.');
  });
});
