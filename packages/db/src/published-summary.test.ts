/**
 * The published summary's rule (Journal v3 J9): which summary a publish
 * keeps, writes or asks the summarizer for, what the extractor indexes, and
 * the shape kept on the node. Pure; the write is pinned in the content DB
 * suites.
 */
import { describe, expect, it } from 'vitest';
import {
  PUBLISHED_SUMMARY_MAX_CHARS,
  cleanSummaryText,
  newPublishedSummary,
  planPublishedSummary,
  readPublishedSummary,
  summaryHash,
  summaryToIndex,
  type PublishedSummary,
} from './published-summary';

const kept = (over: Partial<PublishedSummary> = {}): PublishedSummary => ({
  text: 'A pump log.',
  source: 'publish',
  hash: 'h1',
  at: '2026-10-28T00:00:00.000Z',
  model: 'm',
  ...over,
});

describe('cleanSummaryText', () => {
  it('folds white space and control characters into one line', () => {
    expect(cleanSummaryText('  A pump\n\nlog.\t\u0007 For  crews. ')).toBe(
      'A pump log. For crews.',
    );
  });

  it('cuts at the last word that fits the cap', () => {
    const long = 'word '.repeat(400);
    const out = cleanSummaryText(long);
    expect(out.length).toBeLessThanOrEqual(PUBLISHED_SUMMARY_MAX_CHARS);
    expect(out.endsWith('word')).toBe(true);
  });

  it('is empty for nothing usable', () => {
    expect(cleanSummaryText('   ')).toBe('');
    expect(cleanSummaryText(42)).toBe('');
    expect(newPublishedSummary(' \n ', 'author', 'h')).toBeNull();
  });
});

describe('planPublishedSummary', () => {
  it("writes the author's summary over anything", () => {
    for (const k of [null, kept(), kept({ source: 'author', text: 'Old.' })]) {
      const plan = planPublishedSummary(k, 'New words.', 'h2');
      expect(plan).toMatchObject({
        do: 'write',
        summary: { text: 'New words.', source: 'author', hash: 'h2', model: null },
      });
    }
  });

  it("keeps the same author's summary without a write", () => {
    const k = kept({ source: 'author', text: 'Same.' });
    expect(planPublishedSummary(k, ' Same. ', 'h9')).toEqual({ do: 'keep' });
  });

  it("never generates over an author's summary, whatever changed", () => {
    expect(planPublishedSummary(kept({ source: 'author' }), null, 'other')).toEqual({
      do: 'keep',
    });
  });

  it('keeps a generated summary while its inputs are the same, else generates', () => {
    expect(planPublishedSummary(kept(), '', 'h1')).toEqual({ do: 'keep' });
    expect(planPublishedSummary(kept(), undefined, 'h2')).toEqual({ do: 'generate' });
    expect(planPublishedSummary(null, null, 'h1')).toEqual({ do: 'generate' });
  });
});

describe('summaryToIndex', () => {
  const extracted = { text: 'From the body.', model: 'extractor-model' };

  it("indexes the extractor's own summary when there is no published one", () => {
    expect(summaryToIndex({ summary: 'x' }, extracted)).toEqual({ ...extracted, source: null });
  });

  it('indexes a published summary instead, naming what wrote it', () => {
    const data = (s: PublishedSummary) => ({ ['published' + '_summary']: s });
    expect(summaryToIndex(data(kept()), extracted)).toEqual({
      text: 'A pump log.',
      model: 'm',
      source: 'publish',
    });
    expect(summaryToIndex(data(kept({ source: 'author', model: null })), extracted)).toEqual({
      text: 'A pump log.',
      model: 'author',
      source: 'author',
    });
  });
});

describe('readPublishedSummary', () => {
  it('reads only a well-formed value', () => {
    const key = 'published' + '_summary';
    expect(readPublishedSummary({ [key]: kept() })).toEqual(kept());
    expect(readPublishedSummary({ [key]: { text: 'x', source: 'model' } })).toBeNull();
    expect(readPublishedSummary({ [key]: { text: '  ', source: 'author' } })).toBeNull();
    expect(readPublishedSummary({ [key]: 'x' })).toBeNull();
    expect(readPublishedSummary(null)).toBeNull();
  });
});

describe('summaryHash', () => {
  it('separates its parts', () => {
    expect(summaryHash('ab', 'c')).not.toBe(summaryHash('a', 'bc'));
    expect(summaryHash('x')).toBe(summaryHash('x'));
  });
});
