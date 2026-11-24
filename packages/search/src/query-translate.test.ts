/**
 * The query translation for search languages (query-translate.ts) with the
 * model call stubbed: a cache hit costs no second call, the time budget
 * holds against a slow call (whose late answer still fills the cache), an
 * error or a refusal leaves the language out with one warn line, a long
 * query is not translated, and no route means no call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanAnswer,
  setQueryTranslatorForTests,
  translatePrompt,
  translateQuery,
  TRANSLATE_MAX_CHARS,
  type TranslateCall,
} from './query-translate';

let calls: Array<{ system: string; user: string }> = [];
let warns: string[] = [];

function fake(answer: (user: string, system: string) => Promise<string>): void {
  const call: TranslateCall = async (_route, system, user) => {
    calls.push({ system, user });
    return answer(user, system);
  };
  setQueryTranslatorForTests({ call });
}

beforeEach(() => {
  calls = [];
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
    warns.push(String(m));
  });
});
afterEach(() => {
  setQueryTranslatorForTests(null);
  vi.restoreAllMocks();
});

describe('translateQuery', () => {
  it('no languages, no call', async () => {
    fake(async () => 'x');
    expect(await translateQuery('o', 'pressure valve', [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('translates into each language, and a repeated query is a cache hit', async () => {
    fake(async (_u, system) => (system.includes('Spanish') ? 'válvula de presión' : 'soupape'));
    expect(await translateQuery('o', 'pressure valve', ['es', 'fr'])).toEqual([
      { lang: 'es', text: 'válvula de presión' },
      { lang: 'fr', text: 'soupape' },
    ]);
    expect(calls).toHaveLength(2);
    expect(await translateQuery('o', 'pressure valve', ['es', 'fr'])).toEqual([
      { lang: 'es', text: 'válvula de presión' },
      { lang: 'fr', text: 'soupape' },
    ]);
    expect(calls).toHaveLength(2);
    expect(warns).toEqual([]);
  });

  it('two searches at once share one call', async () => {
    fake(async () => 'válvula');
    const [a, b] = await Promise.all([
      translateQuery('o', 'valve', ['es']),
      translateQuery('o', 'valve', ['es']),
    ]);
    expect(a).toEqual([{ lang: 'es', text: 'válvula' }]);
    expect(b).toEqual([{ lang: 'es', text: 'válvula' }]);
    expect(calls).toHaveLength(1);
  });

  it('a slow call: the search waits no longer than the budget; the late answer fills the cache', async () => {
    let release!: (s: string) => void;
    fake(() => new Promise<string>((r) => (release = r)));
    const t0 = Date.now();
    expect(await translateQuery('o', 'valve', ['es'], { budgetMs: 50 })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('past the time budget');
    release('válvula');
    await new Promise((r) => setTimeout(r, 0));
    expect(await translateQuery('o', 'valve', ['es'], { budgetMs: 50 })).toEqual([
      { lang: 'es', text: 'válvula' },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('an error: the language is left out with one warn line, and asked again next time', async () => {
    fake(async () => {
      throw new Error('provider down');
    });
    expect(await translateQuery('o', 'valve', ['es'])).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('provider down');
    await translateQuery('o', 'valve', ['es']);
    expect(calls).toHaveLength(2);
  });

  it('a refusal (empty or a long talk): left out with a warn line, and not asked again', async () => {
    fake(async () => 'I am sorry, I cannot help with that request. '.repeat(20));
    expect(await translateQuery('o', 'valve', ['es'])).toEqual([]);
    expect(warns[0]).toContain('no translation');
    await translateQuery('o', 'valve', ['es']);
    expect(calls).toHaveLength(1);
    // The kept empty answer is quiet.
    expect(warns).toHaveLength(1);
  });

  it('an answer equal to the query adds nothing', async () => {
    fake(async () => 'PSV-101');
    expect(await translateQuery('o', 'PSV-101', ['es'])).toEqual([]);
  });

  it('a long query is not translated', async () => {
    fake(async () => 'x');
    expect(await translateQuery('o', 'a'.repeat(TRANSLATE_MAX_CHARS + 1), ['es'])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('no translator or summarizer worker: no call, one warn line', async () => {
    setQueryTranslatorForTests({
      call: async () => {
        calls.push({ system: '', user: '' });
        return 'x';
      },
      route: { why: 'no usable translator or summarizer worker (none)' },
    });
    expect(await translateQuery('o', 'valve', ['es'])).toEqual([]);
    expect(calls).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('no usable translator');
  });
});

describe('cleanAnswer and translatePrompt', () => {
  it('trims and takes outer quotes off', () => {
    expect(cleanAnswer('valve', '  "válvula"\n')).toBe('válvula');
    expect(cleanAnswer('valve', '')).toBe('');
  });

  it('names the language by its English name', () => {
    expect(translatePrompt('es')).toContain('Spanish (es)');
    expect(translatePrompt('pt-BR')).toContain('(pt-BR)');
  });
});
