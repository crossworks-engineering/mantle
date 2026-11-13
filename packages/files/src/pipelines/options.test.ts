/**
 * The options of a pipeline: each refusal of checkOptions, effectiveOptions
 * on a bad stored value, and the hash ('' for the defaults, the same for the
 * same values in another key order, other for other values). Pure; a
 * made-up manifest.
 */
import { describe, expect, it } from 'vitest';
import type { PipelineManifest } from './contract';
import { checkOptions, effectiveOptions, optionsHash } from './options';

const M: Pick<PipelineManifest, 'name' | 'options'> = {
  name: 'Made-up tags',
  options: {
    box_mm: { type: 'number', label: 'Box', default: 70, min: 20, max: 300 },
    strict: { type: 'bool', label: 'Strict', default: false },
    not_tags: { type: 'words', label: 'Not tags', default: [], maxItems: 3, maxChars: 8 },
    kinds: { type: 'words', label: 'Kinds', default: ['EA', 'HX'], maxItems: 5, maxChars: 4 },
  },
};

const refused = (input: unknown) => {
  const r = checkOptions(M, input);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
};

describe('checkOptions', () => {
  it('takes declared names with good values, and keeps only the names given', () => {
    expect(checkOptions(M, {})).toEqual({ ok: true, values: {} });
    expect(checkOptions(M, { box_mm: 20, strict: true })).toEqual({
      ok: true,
      values: { box_mm: 20, strict: true },
    });
    expect(checkOptions(M, { box_mm: 300 })).toEqual({ ok: true, values: { box_mm: 300 } });
  });

  it('makes words upper case, trims them and removes doubles', () => {
    expect(checkOptions(M, { not_tags: [' tbd ', 'TBD', 'n/a', 'x-1.2_b'] })).toEqual({
      ok: true,
      values: { not_tags: ['TBD', 'N/A', 'X-1.2_B'] },
    });
  });

  it('refuses input that is not a set of names and values', () => {
    for (const bad of [null, undefined, 'box_mm=1', 7, [], [['box_mm', 1]]]) {
      expect(refused(bad)).toBe('Options must be a set of names and values.');
    }
  });

  it('refuses a name the manifest does not declare, an inherited one too', () => {
    expect(refused({ pattern: '.*' })).toBe('Made-up tags has no option "pattern".');
    expect(refused({ toString: 1 })).toMatch(/has no option "toString"/);
    expect(refused(JSON.parse('{"__proto__": 1}'))).toMatch(/has no option "__proto__"/);
    // A manifest with no options takes none.
    expect(checkOptions({ name: 'Bare' }, { box_mm: 1 })).toEqual({
      ok: false,
      error: 'Bare has no option "box_mm".',
    });
  });

  it('refuses a number of the wrong type or out of min to max', () => {
    for (const bad of [19, 301, -1, Number.NaN, Number.POSITIVE_INFINITY, '70', null, true]) {
      expect(refused({ box_mm: bad })).toBe('Option "box_mm" must be a number from 20 to 300.');
    }
  });

  it('refuses a yes or no that is not a boolean', () => {
    for (const bad of ['true', 1, 0, null, []]) {
      expect(refused({ strict: bad })).toBe('Option "strict" must be yes or no.');
    }
  });

  it('refuses a word list that is not a list, too long, or with a word out of the rule', () => {
    expect(refused({ not_tags: 'TBD' })).toBe('Option "not_tags" must be a list of words.');
    expect(refused({ not_tags: ['A', 'B', 'C', 'D'] })).toBe(
      'Option "not_tags" holds at most 3 words.',
    );
    // Doubles go before the count: four given, three kept.
    expect(checkOptions(M, { not_tags: ['a', 'A', 'b', 'c'] }).ok).toBe(true);
    for (const bad of ['', '   ', 'TOOLONGWD', '-LEAD', '.X', 'A B', 'A*', 'A|B', '(A)', 7, null]) {
      expect(refused({ not_tags: [bad] })).toMatch(
        /^Option "not_tags": .* is not a word\. A word is 1 to 8 of A-Z, 0-9/,
      );
    }
    expect(refused({ kinds: ['ABCDE'] })).toMatch(/A word is 1 to 4 of/);
  });

  it('stops at the first refusal and gives no values', () => {
    expect(checkOptions(M, { box_mm: 30, strict: 'no' })).toEqual({
      ok: false,
      error: 'Option "strict" must be yes or no.',
    });
  });
});

describe('effectiveOptions', () => {
  const defaults = { box_mm: 70, strict: false, not_tags: [], kinds: ['EA', 'HX'] };

  it('gives every declared option its default when nothing is stored', () => {
    for (const stored of [{}, null, undefined, 'junk', 7, []]) {
      expect(effectiveOptions(M, stored)).toEqual(defaults);
    }
    expect(effectiveOptions({}, { box_mm: 1 })).toEqual({});
  });

  it('takes each stored value that passes its spec', () => {
    expect(effectiveOptions(M, { box_mm: 100, not_tags: ['tbd'] })).toEqual({
      ...defaults,
      box_mm: 100,
      not_tags: ['TBD'],
    });
  });

  it('a stored value that no longer passes gives the default, and never throws', () => {
    expect(
      effectiveOptions(M, {
        box_mm: 9_999,
        strict: 'yes',
        not_tags: ['A', 'B', 'C', 'D'],
        kinds: [{}],
        gone: 'an option a later version dropped',
      }),
    ).toEqual(defaults);
  });

  it('a default list is a copy: a caller cannot change the manifest', () => {
    const got = effectiveOptions(M, {});
    (got.kinds as string[]).push('ZZ');
    expect(effectiveOptions(M, {}).kinds).toEqual(['EA', 'HX']);
  });
});

describe('optionsHash', () => {
  it("is '' for the defaults, and for a manifest with no options", () => {
    expect(optionsHash(M, effectiveOptions(M, {}))).toBe('');
    expect(optionsHash(M, {})).toBe('');
    expect(optionsHash(M, { box_mm: 70, kinds: ['EA', 'HX'] })).toBe('');
    expect(optionsHash({}, {})).toBe('');
    expect(optionsHash({}, { box_mm: 9 })).toBe('');
  });

  it('is 8 hex, the same for the same values in another key order', () => {
    const a = optionsHash(M, { box_mm: 100, strict: true, not_tags: ['TBD'], kinds: ['EA'] });
    const b = optionsHash(M, { kinds: ['EA'], not_tags: ['TBD'], strict: true, box_mm: 100 });
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toBe(a);
    // A value left out is its default.
    expect(optionsHash(M, { box_mm: 100 })).toBe(
      optionsHash(M, { box_mm: 100, strict: false, not_tags: [], kinds: ['EA', 'HX'] }),
    );
  });

  it('is other for other values', () => {
    const seen = new Set([
      optionsHash(M, { box_mm: 100 }),
      optionsHash(M, { box_mm: 101 }),
      optionsHash(M, { strict: true }),
      optionsHash(M, { not_tags: ['TBD'] }),
      optionsHash(M, { kinds: ['EA'] }),
      optionsHash(M, { kinds: ['HX', 'EA'] }),
    ]);
    expect(seen.size).toBe(6);
    expect(seen.has('')).toBe(false);
  });

  it('a name the manifest does not declare is not hashed', () => {
    expect(optionsHash(M, { box_mm: 100, gone: 1 })).toBe(optionsHash(M, { box_mm: 100 }));
  });
});
