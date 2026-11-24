/**
 * Search languages in the keyword query (search-languages.ts,
 * query-translate.ts): the merge of the translations' terms (pure), and
 * resolveKeywordQuery with the setting empty (today's query: the same
 * lookup, the same answer, no translation asked) and set. Made-up English
 * and Spanish words only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookups: string[] = [];
let dfByText: Record<string, Array<{ lexeme: string; df: number; rows: number | null }>> = {};
let languages: string[] = [];
const translateCalls: Array<{ query: string; languages: readonly string[] }> = [];
let translations: string[] = [];

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      // mantle_lexeme_df(text, table, ...): the text is the first value.
      execute: vi.fn(async (q: { queryChunks?: unknown[] }) => {
        const text = (q.queryChunks ?? []).find((c) => typeof c === 'string') as string;
        lookups.push(text);
        const rows = dfByText[text];
        if (!rows) throw new Error('no such text');
        return rows;
      }),
    },
  };
});
vi.mock('./search-languages', () => ({
  loadSearchLanguages: vi.fn(async () => languages),
}));
vi.mock('./query-translate', () => ({
  translateQuery: vi.fn(async (_o: string, query: string, langs: readonly string[]) => {
    translateCalls.push({ query, languages: langs });
    return translations;
  }),
}));

const { pickKeywordTerms, pickTranslatedKeywordTerms, resolveKeywordQuery, idfWeight } =
  await import('./keyword-query');

const lexemes = (kq: ReturnType<typeof pickKeywordTerms>) =>
  kq?.mode === 'or' ? kq.terms.map((t) => t.lexeme) : kq;

beforeEach(() => {
  lookups.length = 0;
  translateCalls.length = 0;
  dfByText = {};
  languages = [];
  translations = [];
});

describe('pickTranslatedKeywordTerms', () => {
  const english = [
    { lexeme: 'pressur', df: 0.01 },
    { lexeme: 'valv', df: 0.002 },
  ];
  const spanish = [
    { lexeme: 'presion', df: 0.004 },
    { lexeme: 'valvul', df: 0.001 },
  ];

  it('is today’s query when no translation adds a term', () => {
    expect(pickTranslatedKeywordTerms('pressure valve', english, [])).toEqual(
      pickKeywordTerms('pressure valve', english),
    );
    expect(pickTranslatedKeywordTerms('pressure valve', english, [[]])).toEqual(
      pickKeywordTerms('pressure valve', english),
    );
  });

  it('adds the translations’ rare terms after the original’s, which keep today’s weights', () => {
    const kq = pickTranslatedKeywordTerms('pressure valve', english, [spanish]);
    expect(lexemes(kq)).toEqual(['presion', 'pressur', 'valv', 'valvul']);
    const w = Object.fromEntries(
      (kq as { terms: Array<{ lexeme: string; weight: number }> }).terms.map((t) => [
        t.lexeme,
        t.weight,
      ]),
    );
    // The original's terms rank first (valv, then pressur), as today; then
    // the Spanish ones, rarest first (valvul, then presion).
    expect(w).toEqual({
      valv: idfWeight(0.002, 0),
      pressur: idfWeight(0.01, 1),
      valvul: idfWeight(0.001, 2),
      presion: idfWeight(0.004, 3),
    });
    const today = pickKeywordTerms('pressure valve', english);
    for (const t of today?.mode === 'or' ? today.terms : []) {
      expect(w[t.lexeme]).toBe(t.weight);
    }
    // A row holding the original's rarest term outranks one holding every
    // translated term.
    expect(w.valv!).toBeGreaterThan(w.valvul! + w.presion!);
  });

  it('never lets a translation push an original term out (maxTerms each)', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ lexeme: `es${i}`, df: 0.0001 }));
    const kq = pickTranslatedKeywordTerms('pressure valve', english, [many]);
    expect(lexemes(kq)).toEqual(expect.arrayContaining(['pressur', 'valv', 'es0', 'es7']));
  });

  it('a lexeme two texts share is one term', () => {
    const kq = pickTranslatedKeywordTerms(
      'psv-101 valve',
      [{ lexeme: 'psv-101', df: 0.0005 }],
      [[{ lexeme: 'psv-101', df: 0.0005 }, ...spanish]],
    );
    expect(lexemes(kq)).toEqual(['presion', 'psv-101', 'valvul']);
  });

  it('an English word no row holds: the AND cannot match, the Spanish terms take its place', () => {
    const rows = [
      { lexeme: 'pressur', df: 0 },
      { lexeme: 'valv', df: 0 },
    ];
    expect(pickKeywordTerms('pressure valve', rows)).toEqual({
      mode: 'and',
      text: 'pressure valve',
    });
    expect(lexemes(pickTranslatedKeywordTerms('pressure valve', rows, [spanish]))).toEqual([
      'presion',
      'valvul',
    ]);
  });

  it('keeps today’s AND when every original word is in some row (only common)', () => {
    const common = [
      { lexeme: 'pressur', df: 0.3 },
      { lexeme: 'valv', df: 0.2 },
    ];
    expect(pickTranslatedKeywordTerms('pressure valve', common, [spanish])).toEqual({
      mode: 'and',
      text: 'pressure valve',
    });
  });

  it('a text with no searchable lexeme stays null', () => {
    expect(pickTranslatedKeywordTerms('the of', [], [spanish])).toBeNull();
  });
});

describe('resolveKeywordQuery', () => {
  it('with the setting empty: today’s query, one lookup, no translation asked', async () => {
    dfByText = { 'pressure valve': [{ lexeme: 'valv', df: 0.002, rows: 3 }] };
    const today = pickKeywordTerms('pressure valve', dfByText['pressure valve']!);
    expect(await resolveKeywordQuery('pressure valve', 'content_chunks', 'owner-1')).toEqual(today);
    expect(await resolveKeywordQuery('pressure valve', 'content_chunks')).toEqual(today);
    expect(lookups).toEqual(['pressure valve', 'pressure valve']);
    expect(translateCalls).toEqual([]);
  });

  it('with the setting empty, a failed lookup is today’s AND fallback', async () => {
    expect(await resolveKeywordQuery('unknown words', 'nodes', 'owner-1')).toEqual({
      mode: 'and',
      text: 'unknown words',
    });
    expect(translateCalls).toEqual([]);
  });

  it('with es set: the Spanish terms join the query', async () => {
    languages = ['es'];
    translations = ['válvula de presión'];
    dfByText = {
      'pressure valve': [
        { lexeme: 'pressur', df: 0, rows: 0 },
        { lexeme: 'valv', df: 0, rows: 0 },
      ],
      'válvula de presión': [
        { lexeme: 'valvul', df: 0.001, rows: 2 },
        { lexeme: 'presion', df: 0.004, rows: 8 },
      ],
    };
    const kq = await resolveKeywordQuery('pressure valve', 'content_chunks', 'owner-1');
    expect(lexemes(kq)).toEqual(['presion', 'valvul']);
    expect(translateCalls).toEqual([{ query: 'pressure valve', languages: ['es'] }]);
  });

  it('with es set and no translation (budget, error): today’s query', async () => {
    languages = ['es'];
    translations = [];
    dfByText = { 'pressure valve': [{ lexeme: 'valv', df: 0.002, rows: 3 }] };
    expect(await resolveKeywordQuery('pressure valve', 'nodes', 'owner-1')).toEqual(
      pickKeywordTerms('pressure valve', dfByText['pressure valve']!),
    );
  });

  it('a translation whose lookup fails only leaves its terms out', async () => {
    languages = ['es', 'fr'];
    translations = ['válvula', 'soupape'];
    dfByText = {
      valve: [{ lexeme: 'valv', df: 0.002, rows: 3 }],
      válvula: [{ lexeme: 'valvul', df: 0.001, rows: 2 }],
    };
    expect(lexemes(await resolveKeywordQuery('valve', 'nodes', 'owner-1'))).toEqual([
      'valv',
      'valvul',
    ]);
  });
});
