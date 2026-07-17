import { describe, expect, it } from 'vitest';
import { matchSnippet } from './forum-search';

/**
 * The excerpt builder behind in-thread forum search results. The invariants
 * that matter: the hit is always inside the snippet, ellipses appear exactly
 * where the body was clipped, and the ILIKE-wildcard fallback (SQL matched but
 * plain indexOf can't) degrades to the head of the body instead of throwing.
 */

const CTX = 60;

describe('matchSnippet', () => {
  it('returns a short body whole, no ellipses', () => {
    expect(matchSnippet('the deploy is done', 'deploy')).toBe('the deploy is done');
  });

  it('clips both sides of a mid-body hit and marks both with ellipses', () => {
    const body = `${'a'.repeat(200)} deploy ${'b'.repeat(200)}`;
    const snippet = matchSnippet(body, 'deploy');
    expect(snippet).toContain('deploy');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    // ~ctx chars each side of the hit, plus the two ellipses.
    expect(snippet.length).toBeLessThanOrEqual('deploy'.length + CTX * 2 + 2);
  });

  it('omits the leading ellipsis when the hit is at the start', () => {
    const body = `deploy went out ${'x'.repeat(200)}`;
    const snippet = matchSnippet(body, 'deploy');
    expect(snippet.startsWith('deploy')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('omits the trailing ellipsis when the hit is at the end', () => {
    const body = `${'x'.repeat(200)} finished the deploy`;
    const snippet = matchSnippet(body, 'deploy');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('deploy')).toBe(true);
  });

  it('finds the hit case-insensitively', () => {
    const snippet = matchSnippet(`${'x'.repeat(100)} DEPLOY ${'y'.repeat(100)}`, 'deploy');
    expect(snippet).toContain('DEPLOY');
  });

  it('centres on the FIRST hit when there are several', () => {
    const body = `deploy one ${'x'.repeat(300)} deploy two`;
    expect(matchSnippet(body, 'deploy').startsWith('deploy one')).toBe(true);
  });

  it('falls back to the head of the body when indexOf misses (ILIKE wildcards)', () => {
    // SQL `body ILIKE '%a%b%'` matches this row, but indexOf('a%b') does not.
    const body = `alpha bravo ${'z'.repeat(300)}`;
    const snippet = matchSnippet(body, 'a%b');
    expect(snippet).toBe(body.slice(0, CTX * 2).trim());
  });

  it('trims clipped-edge whitespace inside the excerpt', () => {
    const body = `${'x'.repeat(59)} deploy`;
    const snippet = matchSnippet(body, 'deploy');
    expect(snippet).toBe(snippet.trim());
  });
});
