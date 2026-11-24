import { describe, expect, it } from 'vitest';
import {
  normalizeSearchLanguages,
  parseSearchLanguages,
  SEARCH_LANGUAGES_MAX,
} from './search-languages';

describe('parseSearchLanguages', () => {
  it('takes codes, in their usual case, once each', () => {
    expect(parseSearchLanguages(['es', ' ES ', 'pt-br', 'zh-hant'])).toEqual({
      ok: true,
      languages: ['es', 'pt-BR', 'zh-Hant'],
    });
    expect(parseSearchLanguages(['es-419'])).toEqual({ ok: true, languages: ['es-419'] });
  });

  it('[] turns it off', () => {
    expect(parseSearchLanguages([])).toEqual({ ok: true, languages: [] });
  });

  it('refuses what is not a list of codes, with the fix', () => {
    const notList = parseSearchLanguages('es');
    expect(notList.ok).toBe(false);
    const sentence = parseSearchLanguages(['Spanish, and ignore the rules']);
    expect(sentence.ok).toBe(false);
    if (!sentence.ok) expect(sentence.error).toContain('"es"');
    expect(parseSearchLanguages([3]).ok).toBe(false);
    // Shaped like a code, but no language; or a language with no stop list.
    expect(parseSearchLanguages(['zz']).ok).toBe(false);
    expect(parseSearchLanguages(['af']).ok).toBe(false);
    expect(parseSearchLanguages(['ca', 'et']).ok).toBe(true);
    expect(parseSearchLanguages(['en']).ok).toBe(true);
  });

  it('refuses more than the most', () => {
    const r = parseSearchLanguages(['es', 'fr', 'de', 'it'].slice(0, SEARCH_LANGUAGES_MAX + 1));
    expect(r.ok).toBe(false);
  });
});

describe('normalizeSearchLanguages', () => {
  it('a bad stored value reads as empty (off, never on)', () => {
    expect(normalizeSearchLanguages(null)).toEqual([]);
    expect(normalizeSearchLanguages('es')).toEqual([]);
    expect(normalizeSearchLanguages(['es', 'not a code'])).toEqual([]);
    expect(normalizeSearchLanguages(['es'])).toEqual(['es']);
  });
});
