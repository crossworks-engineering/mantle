import { describe, expect, it } from 'vitest';
import { parseSearchQuery, SEARCH_NODE_TYPES } from './search-query';

const sp = (query: string) => new URLSearchParams(query);

describe('parseSearchQuery', () => {
  it('requires q', () => {
    expect(parseSearchQuery(sp(''))).toEqual({ error: 'q required' });
    expect(parseSearchQuery(sp('q=%20%20'))).toEqual({ error: 'q required' });
  });

  it('defaults: nodes mode, limit 20', () => {
    const r = parseSearchQuery(sp('q=printer'));
    expect(r).toEqual({
      q: 'printer',
      mode: 'nodes',
      type: undefined,
      branch: undefined,
      tags: undefined,
      limit: 20,
    });
  });

  it('accepts chunks mode, rejects unknown modes', () => {
    expect(parseSearchQuery(sp('q=x&mode=chunks'))).toMatchObject({ mode: 'chunks' });
    expect(parseSearchQuery(sp('q=x&mode=fuzzy'))).toEqual({
      error: "mode must be 'nodes' or 'chunks'",
    });
  });

  it('validates type against the tool enum', () => {
    for (const t of SEARCH_NODE_TYPES) {
      expect(parseSearchQuery(sp(`q=x&type=${t}`))).toMatchObject({ type: t });
    }
    expect(parseSearchQuery(sp('q=x&type=widget'))).toEqual({ error: "unknown type 'widget'" });
  });

  it('validates branch as ltree-safe', () => {
    expect(parseSearchQuery(sp('q=x&branch=files.work'))).toMatchObject({ branch: 'files.work' });
    expect(parseSearchQuery(sp('q=x&branch=files.work;drop'))).toEqual({
      error: 'invalid branch',
    });
    expect(parseSearchQuery(sp('q=x&branch=.leading'))).toEqual({ error: 'invalid branch' });
  });

  it('splits tags on commas, trims, drops empties, caps at 10', () => {
    expect(parseSearchQuery(sp('q=x&tags=work,%20home%20,,'))).toMatchObject({
      tags: ['work', 'home'],
    });
    const many = Array.from({ length: 14 }, (_, i) => `t${i}`).join(',');
    const r = parseSearchQuery(sp(`q=x&tags=${many}`));
    expect(r).toMatchObject({ tags: Array.from({ length: 10 }, (_, i) => `t${i}`) });
    expect(parseSearchQuery(sp('q=x&tags=%20,'))).toMatchObject({ tags: undefined });
  });

  it('clamps limit to 1..50 with default 20', () => {
    expect(parseSearchQuery(sp('q=x&limit=5'))).toMatchObject({ limit: 5 });
    expect(parseSearchQuery(sp('q=x&limit=500'))).toMatchObject({ limit: 50 });
    expect(parseSearchQuery(sp('q=x&limit=0'))).toEqual({ error: 'invalid limit' });
    expect(parseSearchQuery(sp('q=x&limit=abc'))).toEqual({ error: 'invalid limit' });
  });

  it('rejects an over-long q', () => {
    expect(parseSearchQuery(sp(`q=${'a'.repeat(501)}`))).toEqual({
      error: 'q too long (max 500)',
    });
  });
});
