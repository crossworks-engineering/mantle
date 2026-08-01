import { describe, expect, it } from 'vitest';
import { bearerFrom, cookieValues } from './request';

/**
 * These two parsers were re-implemented four and two times respectively, and
 * the copies had drifted. The tests pin the single agreed behaviour — above all
 * the null-vs-empty distinction, which is what lets a gate tell "no credential
 * was offered" from "a broken one was", and so decide whether falling through
 * to a cookie is safe.
 */

const withHeaders = (headers: Record<string, string>) =>
  new Request('https://example.test/', { headers });

describe('bearerFrom', () => {
  it('returns null when no Authorization header is present', () => {
    expect(bearerFrom(withHeaders({}))).toBeNull();
  });

  it('returns null for a non-bearer scheme', () => {
    expect(bearerFrom(withHeaders({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull();
    expect(bearerFrom(withHeaders({ authorization: 'Bearerish token' }))).toBeNull();
  });

  it('extracts the token regardless of scheme casing', () => {
    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
      expect(bearerFrom(withHeaders({ authorization: `${scheme} tok-1` }))).toBe('tok-1');
    }
  });

  it('tolerates surrounding and repeated whitespace', () => {
    expect(bearerFrom(withHeaders({ authorization: '  Bearer   tok-1  ' }))).toBe('tok-1');
    expect(bearerFrom(withHeaders({ authorization: 'Bearer\ttok-1' }))).toBe('tok-1');
  });

  it('reports a PRESENT but empty bearer as empty string, not null', () => {
    // The distinction a gate depends on: the caller offered a credential, so it
    // must be judged on that and never fall through to a cookie.
    expect(bearerFrom(withHeaders({ authorization: 'Bearer' }))).toBe('');
    expect(bearerFrom(withHeaders({ authorization: 'Bearer   ' }))).toBe('');
  });

  it('keeps a token containing spaces intact after trimming', () => {
    expect(bearerFrom(withHeaders({ authorization: 'Bearer a b' }))).toBe('a b');
  });
});

describe('cookieValues', () => {
  it('returns an empty list for a missing or empty header', () => {
    expect(cookieValues(null, 'x')).toEqual([]);
    expect(cookieValues('', 'x')).toEqual([]);
  });

  it('reads the named cookie and ignores the others', () => {
    expect(cookieValues('a=1; target=hit; b=2', 'target')).toEqual(['hit']);
  });

  it('returns every copy, so a host- and path-scoped pair are both tried', () => {
    expect(cookieValues('t=first; other=x; t=second', 't')).toEqual(['first', 'second']);
  });

  it('url-decodes values and tolerates whitespace around pairs', () => {
    expect(cookieValues('  t = a%2Fb ; t=plain', 't')).toEqual(['a/b', 'plain']);
  });

  it('skips valueless and malformed entries', () => {
    expect(cookieValues('t=; t; =t; t=ok', 't')).toEqual(['ok']);
  });

  it('does not match a cookie whose name merely contains the target', () => {
    expect(cookieValues('mantle_team_chat=v', 'mantle_team')).toEqual([]);
  });
});
