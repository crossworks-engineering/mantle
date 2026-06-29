/**
 * Tests for the pure parts of section reading (the rung between search_chunks
 * and a whole-file read): outline grouping, selector matching, and capped
 * assembly. The DB wrapper `readSection` is exercised live against Postgres in
 * the verify step — same split as tool-results.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { buildSectionOutline, selectSectionChunks, assembleSection } from './chunks';

type Chunk = { ordinal: number; heading: string | null; text: string };
const mk = (ordinal: number, heading: string | null, text = `t${ordinal}`): Chunk => ({
  ordinal,
  heading,
  text,
});

describe('buildSectionOutline', () => {
  it('groups consecutive same-heading contiguous passages into one range', () => {
    const out = buildSectionOutline([mk(0, 'Intro'), mk(1, 'Intro'), mk(2, 'Body')]);
    expect(out).toEqual([
      { heading: 'Intro', fromOrdinal: 0, toOrdinal: 1, passages: 2 },
      { heading: 'Body', fromOrdinal: 2, toOrdinal: 2, passages: 1 },
    ]);
  });

  it('splits a shared heading that is not ordinal-contiguous into separate ranges', () => {
    const out = buildSectionOutline([mk(0, 'A'), mk(1, 'B'), mk(2, 'A')]);
    expect(out.map((r) => [r.heading, r.fromOrdinal, r.toOrdinal])).toEqual([
      ['A', 0, 0],
      ['B', 1, 1],
      ['A', 2, 2],
    ]);
  });

  it('treats null headings as their own group', () => {
    const out = buildSectionOutline([mk(0, null), mk(1, null), mk(2, 'X')]);
    expect(out).toEqual([
      { heading: null, fromOrdinal: 0, toOrdinal: 1, passages: 2 },
      { heading: 'X', fromOrdinal: 2, toOrdinal: 2, passages: 1 },
    ]);
  });

  it('is empty for no chunks', () => {
    expect(buildSectionOutline([])).toEqual([]);
  });
});

describe('selectSectionChunks', () => {
  const chunks = [mk(0, 'Scope'), mk(1, 'CoF Assessment'), mk(2, 'CoF Assessment'), mk(3, 'Risk')];

  it('matches a heading case-insensitively by substring, in ordinal order', () => {
    const res = selectSectionChunks(chunks, { heading: 'cof' });
    expect(Array.isArray(res) && res.map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('errors (not throws) when a heading matches nothing', () => {
    const res = selectSectionChunks(chunks, { heading: 'nope' });
    expect('error' in res && res.error).toMatch(/no passage under a heading/);
  });

  it('selects an ordinal range inclusive', () => {
    const res = selectSectionChunks(chunks, { fromOrdinal: 1, toOrdinal: 2 });
    expect(Array.isArray(res) && res.map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('treats from_ordinal alone as a single passage', () => {
    const res = selectSectionChunks(chunks, { fromOrdinal: 3 });
    expect(Array.isArray(res) && res.map((c) => c.ordinal)).toEqual([3]);
  });

  it('swaps a reversed range', () => {
    const res = selectSectionChunks(chunks, { fromOrdinal: 2, toOrdinal: 1 });
    expect(Array.isArray(res) && res.map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('errors on an out-of-range ordinal selector', () => {
    const res = selectSectionChunks(chunks, { fromOrdinal: 9, toOrdinal: 12 });
    expect('error' in res && res.error).toMatch(/no passages in ordinal range/);
  });

  it('errors when no selector is given', () => {
    const res = selectSectionChunks(chunks, {});
    expect('error' in res && res.error).toMatch(/no selector/);
  });

  it('prefers heading over an ordinal range when both are present', () => {
    const res = selectSectionChunks(chunks, { heading: 'risk', fromOrdinal: 0, toOrdinal: 0 });
    expect(Array.isArray(res) && res.map((c) => c.ordinal)).toEqual([3]);
  });
});

describe('assembleSection', () => {
  it('joins passages and emits a heading marker only when the heading changes', () => {
    const r = assembleSection([mk(0, 'A', 'one'), mk(1, 'A', 'two'), mk(2, 'B', 'three')], 24000);
    expect(r.text).toBe('## A\n\none\n\ntwo\n\n## B\n\nthree');
    expect(r.truncated).toBe(false);
    expect(r.nextOrdinal).toBeNull();
  });

  it('caps on the character budget and reports the next ordinal to continue from', () => {
    const big = (o: number) => mk(o, 'S', 'x'.repeat(1500));
    const r = assembleSection([big(0), big(1), big(2)], 2000);
    expect(r.taken.map((c) => c.ordinal)).toEqual([0]); // second would exceed 2000
    expect(r.truncated).toBe(true);
    expect(r.nextOrdinal).toBe(1);
  });

  it('always takes at least the first passage even if it alone exceeds the cap', () => {
    const r = assembleSection([mk(0, 'S', 'y'.repeat(5000)), mk(1, 'S', 'z')], 2000);
    expect(r.taken.map((c) => c.ordinal)).toEqual([0]);
    expect(r.truncated).toBe(true);
    expect(r.nextOrdinal).toBe(1);
  });

  it('does not truncate when everything fits', () => {
    const r = assembleSection([mk(0, null, 'a'), mk(1, null, 'b')], 24000);
    expect(r.text).toBe('a\n\nb');
    expect(r.truncated).toBe(false);
  });
});
