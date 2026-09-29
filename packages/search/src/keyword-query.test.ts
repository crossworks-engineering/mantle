import { describe, expect, it } from 'vitest';
import { idfWeight, lexemesToTsqueryText, pickKeywordTerms } from './keyword-query';

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
        { lexeme: 'budget', weight: idfWeight(0.02) },
        { lexeme: 'e4471', weight: idfWeight(0.002) },
      ],
    });
    // One rare hit beats a common word; ln(1/0.002) ≈ 6.2 vs ln(1/0.02) ≈ 3.9.
    expect(idfWeight(0.002)).toBeGreaterThan(idfWeight(0.02));
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

describe('lexemesToTsqueryText', () => {
  it('quotes each lexeme and joins with OR', () => {
    expect(lexemesToTsqueryText(['cach', 'v0.232.325'])).toBe("'cach' | 'v0.232.325'");
  });

  it('escapes quotes and backslashes so the lexeme is taken verbatim', () => {
    expect(lexemesToTsqueryText(["o'neil", 'a\\b'])).toBe("'o''neil' | 'a\\\\b'");
  });
});
