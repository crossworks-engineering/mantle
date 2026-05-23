import { describe, expect, it } from 'vitest';
import { extractCitations } from './builtins-research';

describe('extractCitations', () => {
  it('reads a top-level citations string array (Perplexity classic shape)', () => {
    expect(
      extractCitations({ citations: ['https://a.com', 'https://b.com'] }),
    ).toEqual(['https://a.com', 'https://b.com']);
  });

  it('reads top-level citation objects with a url field', () => {
    expect(
      extractCitations({ citations: [{ url: 'https://a.com', title: 'A' }] }),
    ).toEqual(['https://a.com']);
  });

  it('reads per-message url_citation annotations (OpenRouter web shape)', () => {
    const resp = {
      choices: [
        {
          message: {
            content: 'answer',
            annotations: [
              { type: 'url_citation', url_citation: { url: 'https://c.com' } },
              { url: 'https://d.com' },
            ],
          },
        },
      ],
    };
    expect(extractCitations(resp)).toEqual(['https://c.com', 'https://d.com']);
  });

  it('merges + de-duplicates across both shapes', () => {
    const resp = {
      citations: ['https://a.com'],
      choices: [
        { message: { annotations: [{ url_citation: { url: 'https://a.com' } }, { url: 'https://e.com' }] } },
      ],
    };
    expect(extractCitations(resp)).toEqual(['https://a.com', 'https://e.com']);
  });

  it('returns an empty array for missing / malformed responses', () => {
    expect(extractCitations(null)).toEqual([]);
    expect(extractCitations(undefined)).toEqual([]);
    expect(extractCitations({})).toEqual([]);
    expect(extractCitations({ citations: 'nope' })).toEqual([]);
    expect(extractCitations({ choices: [{ message: { annotations: [{}] } }] })).toEqual([]);
  });
});
