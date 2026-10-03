import { describe, expect, it } from 'vitest';
import { gateRareTerms, idfWeight, lexemesToTsqueryText, pickKeywordTerms } from './keyword-query';

const lexemes = (kq: ReturnType<typeof pickKeywordTerms>) =>
  kq?.mode === 'or' ? kq.terms.map((t) => t.lexeme) : kq;

describe('pickKeywordTerms', () => {
  it('returns null when the text has no searchable lexeme (stopwords only)', () => {
    expect(pickKeywordTerms('what is it', [])).toBeNull();
  });

  it('keeps the rarest terms, ORed, dropping ones above the df ceiling', () => {
    const kq = pickKeywordTerms(
      'what did we decide about the valve, embedding cache and the workstation',
      [
        { lexeme: 'valv', df: 0.01 },
        { lexeme: 'decid', df: 0.2 },
        { lexeme: 'embed', df: 0.04 },
        { lexeme: 'cach', df: 0.002 },
        { lexeme: 'workstat', df: 0.001 },
      ],
    );
    expect(lexemes(kq)).toEqual(['cach', 'embed', 'valv', 'workstat']);
  });

  it('weights each kept term by rarity, so a rare code outweighs a common word', () => {
    const kq = pickKeywordTerms('q', [
      { lexeme: 'e4471', df: 0.002 },
      { lexeme: 'budget', df: 0.02 },
    ]);
    expect(kq).toEqual({
      mode: 'or',
      terms: [
        { lexeme: 'budget', weight: idfWeight(0.02, 1), rows: null },
        { lexeme: 'e4471', weight: idfWeight(0.002, 0), rows: null },
      ],
    });
    // One rare hit beats a common word; ln(1/0.002) ≈ 6.2 vs ln(1/0.02)/2 ≈ 2.0.
    expect(idfWeight(0.002)).toBeGreaterThan(idfWeight(0.02, 1));
  });

  it('lets the rarest term outweigh a question frame of ordinary words together', () => {
    const kq = pickKeywordTerms('q', [
      { lexeme: 'nautilus', df: 0.0001 },
      { lexeme: 'commentari', df: 0.0012 },
      { lexeme: 'behavior', df: 0.002 },
      { lexeme: 'threaten', df: 0.01 },
      { lexeme: 'psalm', df: 0.029 },
    ]);
    if (kq?.mode !== 'or') throw new Error('expected an OR query');
    const w = Object.fromEntries(kq.terms.map((t) => [t.lexeme, t.weight]));
    // A plain IDF sum let these four outvote the one word that matters.
    expect(w.nautilus!).toBeGreaterThan(w.commentari! + w.behavior! + w.threaten! + w.psalm!);
  });

  it('drops question-frame words, which can be rare in an old corpus', () => {
    const kq = pickKeywordTerms('what is the perspective of the author on the vase', [
      { lexeme: 'perspect', df: 0.0001 },
      { lexeme: 'author', df: 0.02 },
      { lexeme: 'vase', df: 0.0005 },
    ]);
    expect(lexemes(kq)).toEqual(['vase']);
  });

  it('drops chat filler, which is rare in documents but carries no content', () => {
    const kq = pickKeywordTerms('hey quick one, what about task 0634cb44', [
      { lexeme: 'hey', df: 0.0006 },
      { lexeme: 'quick', df: 0.02 },
      { lexeme: 'got', df: 0.02 },
      { lexeme: '0634cb44', df: 0.002 },
    ]);
    expect(lexemes(kq)).toEqual(['0634cb44']);
  });

  it('drops a term that matches no row (a typo cannot take a slot)', () => {
    const kq = pickKeywordTerms('q', [
      { lexeme: 'morth', df: 0 },
      { lexeme: 'task', df: 0.01 },
    ]);
    expect(lexemes(kq)).toEqual(['task']);
  });

  it('caps at maxTerms, keeping the lowest df (ties broken by lexeme, stable)', () => {
    const kq = pickKeywordTerms(
      'x',
      [
        { lexeme: 'd', df: 0.03 },
        { lexeme: 'b', df: 0.001 },
        { lexeme: 'a', df: 0.001 },
        { lexeme: 'c', df: 0.01 },
      ],
      { maxTerms: 3 },
    );
    expect(lexemes(kq)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to the original AND query when every term is common or absent', () => {
    expect(
      pickKeywordTerms('project status', [
        { lexeme: 'project', df: 0.4 },
        { lexeme: 'status', df: 0.3 },
      ]),
    ).toEqual({ mode: 'and', text: 'project status' });
    expect(pickKeywordTerms('zzqx', [{ lexeme: 'zzqx', df: 0 }])).toEqual({
      mode: 'and',
      text: 'zzqx',
    });
  });

  it('treats a non-finite df as unusable', () => {
    const kq = pickKeywordTerms('q', [
      { lexeme: 'nan', df: Number.NaN },
      { lexeme: 'valv', df: 0.001 },
    ]);
    expect(lexemes(kq)).toEqual(['valv']);
  });
});

describe('gateRareTerms', () => {
  const kq = pickKeywordTerms('q', [
    { lexeme: 'portland', df: 0.00001, rows: 2 },
    { lexeme: 'vase', df: 0.0005, rows: 61 },
    { lexeme: 'valu', df: 0.02, rows: 2200 },
    { lexeme: 'isaiah', df: 0.03, rows: null },
  ])!;

  it('narrows the match to terms no more rows than the cap hold', () => {
    const gated = gateRareTerms(kq, 50);
    expect(gated).toMatchObject({ mode: 'or', match: ['portland'] });
    // Ranking still weighs every term.
    expect(gated?.mode === 'or' && gated.terms.length).toBe(4);
    expect(gateRareTerms(kq, 100)).toMatchObject({ match: ['portland', 'vase'] });
  });

  it('silences the arm when no term is rare enough (unknown counts never pass)', () => {
    expect(gateRareTerms(kq, 1)).toBeNull();
  });

  it('passes the AND fallback through untouched', () => {
    const and = { mode: 'and', text: 'project status' } as const;
    expect(gateRareTerms(and, 50)).toBe(and);
  });
});

describe('lexemesToTsqueryText', () => {
  it('quotes each lexeme and joins with OR', () => {
    expect(lexemesToTsqueryText(['cach', 'v0.232.325'])).toBe("'cach' | 'v0.232.325'");
  });

  it('escapes quotes and backslashes so the lexeme is taken verbatim', () => {
    expect(lexemesToTsqueryText(["o'neil", 'a\\b'])).toBe("'o''neil' | 'a\\\\b'");
  });
});
