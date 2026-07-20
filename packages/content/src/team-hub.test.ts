import { describe, expect, it } from 'vitest';
import { excerptFromDocText } from './team-hub';

// excerptFromDocText backs the team-visible listings' summary FALLBACK: a page
// whose LLM summary is missing (never indexed, or in the commit→re-extract
// window where commitPage just cleared it) shows the head of its published
// plaintext instead of a blank line. Input is the SQL-side LEFT(doc_text, 280)
// head, so the word-boundary trim to ~240 chars always has slack to cut in.
describe('excerptFromDocText', () => {
  it('is null for absent or blank text', () => {
    expect(excerptFromDocText(null)).toBeNull();
    expect(excerptFromDocText('')).toBeNull();
    expect(excerptFromDocText('   \n  ')).toBeNull();
  });

  it('flattens headings and whitespace into one line', () => {
    expect(excerptFromDocText('# Roadmap\n\nQ3 priorities:\nship search.')).toBe(
      'Roadmap Q3 priorities: ship search.',
    );
  });

  it('returns short text whole, no ellipsis', () => {
    expect(excerptFromDocText('Just a line.')).toBe('Just a line.');
  });

  it('cuts long text at a word boundary with a trailing ellipsis', () => {
    // 11-char words: a raw 240-char cut lands mid-word, so the boundary trim
    // must drop the partial — every token before the ellipsis stays whole.
    const out = excerptFromDocText('abcdefghij '.repeat(26).trim())!;
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(241); // 240 + ellipsis
    const lastToken = out.slice(0, -1).split(' ').at(-1);
    expect(lastToken).toBe('abcdefghij');
  });

  it('strips only line-leading heading markers, not an inline #', () => {
    expect(excerptFromDocText('Ticket #42 is done')).toBe('Ticket #42 is done');
  });
});
