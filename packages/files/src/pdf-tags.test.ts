import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  instrumentTagOf,
  listItemsOf,
  parseEquipmentTag,
  tagKey,
  parseInstrumentTag,
  parseIsaCode,
  parseLineNumber,
  TAG_LIKE,
  TOKEN_MAX_CHARS,
  tokenItems,
  tokenKind,
  tokensOf,
  type SiteProfile,
} from './pdf-tags';

/** The equipment tags one token names, by the one order of trial. */
function equipmentTagsOf(token: string) {
  const read = tokenItems(token);
  return read?.kind === 'equipment' ? read.items.map((item) => parseEquipmentTag(item)!) : [];
}

describe('tokensOf', () => {
  it('cuts at white space and list marks, in upper case', () => {
    expect(tokensOf('see fic-101, (pt-7a); 4"-P-1001-A1')).toEqual([
      'SEE',
      'FIC-101',
      'PT-7A',
      '4"-P-1001-A1',
    ]);
  });
  it('keeps a slash inside a token (a bank of equipment)', () => {
    expect(tokensOf('P-12A/B')).toEqual(['P-12A/B']);
  });
  it('makes every inch mark the one quote, and a fraction sign one size', () => {
    // The double prime (NFKC makes it two primes), the closing quote.
    expect(tokensOf('4″-P-1001-A1A')).toEqual(['4"-P-1001-A1A']);
    expect(tokensOf('4”-P-1001-A1A')).toEqual(['4"-P-1001-A1A']);
    expect(tokensOf('4′′-P-1001-A1A')).toEqual(['4"-P-1001-A1A']);
    // A fraction sign, alone and after a whole number.
    expect(tokensOf('½"-P-1001-A1A')).toEqual(['1/2"-P-1001-A1A']);
    expect(tokensOf('1½"-P-1001-A1A')).toEqual(['1-1/2"-P-1001-A1A']);
    expect(tokensOf('1⁄2"-P-1001-A1A')).toEqual(['1/2"-P-1001-A1A']);
  });
  it('cuts a size with a space or a decimal comma: that line number is not read (stated)', () => {
    expect(tokensOf('1 1/2"-P-1001-A1A')).toEqual(['1', '1/2"-P-1001-A1A']);
    expect(tokensOf('1,5"-P-1001-A1A')).toEqual(['1', '5"-P-1001-A1A']);
  });
  it('drops the dots at the end of a short token only', () => {
    expect(tokensOf('see FIC-101.')).toEqual(['SEE', 'FIC-101']);
    const long = `${'.'.repeat(TOKEN_MAX_CHARS)}X.`;
    expect(tokensOf(long)).toEqual([long]);
    // A long run of dots costs no time to read.
    const t0 = Date.now();
    tokensOf(`${'.'.repeat(200_000)}X`);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('listItemsOf', () => {
  it('splits a list after a token into one token an item', () => {
    expect(listItemsOf('FIC-101')).toEqual(['FIC-101']);
    expect(listItemsOf('PSV-101A/B')).toEqual(['PSV-101A', 'PSV-101B']);
    expect(listItemsOf('TE-101A/B/C')).toEqual(['TE-101A', 'TE-101B', 'TE-101C']);
    expect(listItemsOf('10-FV-101/102')).toEqual(['10-FV-101', '10-FV-102']);
    expect(listItemsOf('101A/B')).toEqual(['101A', '101B']);
  });
  it('gives nothing when an item does not fit the end', () => {
    expect(listItemsOf('E-101/B')).toEqual([]);
    expect(listItemsOf('P-1A/BCD')).toEqual([]);
  });
  it('leaves a size alone', () => {
    expect(listItemsOf('1/2"')).toEqual(['1/2"']);
    expect(listItemsOf('1-1/2"-P-1001-A1A')).toEqual(['1-1/2"-P-1001-A1A']);
  });
});

describe('parseIsaCode', () => {
  it.each([
    ['FIC', { variable: 'F', modifier: '', functions: 'IC', level: '', role: 'controller' }],
    ['PT', { variable: 'P', modifier: '', functions: 'T', level: '', role: 'sensor' }],
    ['PDT', { variable: 'P', modifier: 'D', functions: 'T', level: '', role: 'sensor' }],
    ['PSV', { variable: 'P', modifier: 'S', functions: 'V', level: '', role: 'final_element' }],
    ['LSHH', { variable: 'L', modifier: '', functions: 'S', level: 'HH', role: 'sensor' }],
    ['LAL', { variable: 'L', modifier: '', functions: 'A', level: 'L', role: 'sensor' }],
    ['FFC', { variable: 'F', modifier: 'F', functions: 'C', level: '', role: 'controller' }],
    ['FQI', { variable: 'F', modifier: 'Q', functions: 'I', level: '', role: 'sensor' }],
    ['LL', { variable: 'L', modifier: '', functions: 'L', level: '', role: 'sensor' }],
    ['PCV', { variable: 'P', modifier: '', functions: 'CV', level: '', role: 'final_element' }],
    ['SDV', { variable: '', modifier: '', functions: 'SDV', level: '', role: 'final_element' }],
  ])('%s', (code, want) => {
    expect(parseIsaCode(code)).toMatchObject({ code, ...want });
  });

  it.each(['TK', 'E', 'DE', 'FH', 'FQ', 'PUMP', 'ABCDEFG', 'F1C', ''])(
    '%s is no ISA code',
    (code) => {
      expect(parseIsaCode(code)).toBeNull();
    },
  );
});

describe('parseInstrumentTag', () => {
  it.each([
    ['FIC-101', 'FIC-101', '', 'F-101'],
    ['PT1234A', 'PT-1234A', '', 'P-1234'],
    // The tag keeps its digits as written; the loop key joins one loop.
    ['40-PSV-0012', '40-PSV-0012', '40', 'P-12'],
    ['40PSV0012', '40-PSV-0012', '40', 'P-12'],
    ['u2-lt-07', 'U2-LT-07', 'U2', 'L-7'],
    ['01-FIC-0101', '01-FIC-0101', '01', 'F-101'],
  ])('%s', (token, tag, prefix, loopKey) => {
    expect(parseInstrumentTag(token)).toMatchObject({ tag, prefix, loopKey });
  });

  it.each([
    ...['E-101', 'TK-12', 'FIC-1', 'FIC', '101', 'U2-E-7', 'PUMP-101'],
    // A date, a standard and a plain word are not instruments.
    ...['APR-2026', 'SEP-2025', 'ISO-9001', 'API-650', 'TAG-01', 'REV-02'],
  ])('%s is no instrument tag', (token) => {
    expect(parseInstrumentTag(token)).toBeNull();
  });

  it('builds a bubble from its two parts, and joins a loop by its variable', () => {
    expect(instrumentTagOf('ft', '0101')).toMatchObject({ tag: 'FT-0101', loopKey: 'F-101' });
    expect(instrumentTagOf('FV', '101')?.loopKey).toBe('F-101');
    expect(instrumentTagOf('TK', '101')).toBeNull();
    expect(instrumentTagOf('FT', '1')).toBeNull();
  });
});

describe('parseLineNumber', () => {
  it.each([
    ['4"-P-1001-A1B', '4"', '1001'],
    ['1.5"-HC-12345-B2A-IH', '1.5"', '12345'],
    ['P-1001-4"-A1B', '4"', '1001'],
    ['100-HC-12345-B2A', '100', '12345'],
    ['DN50-CW-2001-C1', 'DN50', '2001'],
    ['U2-6"-P-1001-A1', '6"', '1001'],
    ['1-1/2"-P-1001-A1A', '1-1/2"', '1001'],
    ['2-1/2"-HC-2002-B2A', '2-1/2"', '2002'],
    ['1/2"-P-1001-A1A', '1/2"', '1001'],
  ])('%s', (token, size, serial) => {
    expect(parseLineNumber(token)).toMatchObject({ line: token, size, serial });
  });

  it.each([
    'E-101', // too few parts
    'FIC-101-A', // no size
    '100-200-P', // a size and no serial apart from sizes
    '4"-1001-2002', // no letters
    'U2-E-7-X', // no size, no serial
    'A-B-C-D-E-F-G-1001', // too many parts
    '15-JAN-2026', // a date: the day is a pipe size, the year would be a serial
    '25-SEPT-2025',
  ])('%s is no line number', (token) => {
    expect(parseLineNumber(token)).toBeNull();
  });
});

describe('parseEquipmentTag', () => {
  it.each([
    ['E-101', { tag: 'E-101', unit: '', type: 'E', number: '101', sub: '' }],
    ['U2-TK-01', { tag: 'U2-TK-01', unit: 'U2', type: 'TK', number: '01', sub: '' }],
    // A fourth part, written with or without its own dash.
    ['U2-C-1A-E1', { tag: 'U2-C-1A-E1', unit: 'U2', type: 'C', number: '1A', sub: 'E1' }],
    ['U2-C-1A-E-1B', { tag: 'U2-C-1A-E-1B', unit: 'U2', type: 'C', number: '1A', sub: 'E-1B' }],
  ])('%s', (token, tag) => {
    expect(parseEquipmentTag(token)).toEqual(tag);
  });

  it('a word of the drawing frame, a standard or a pipe term is no type: no tag', () => {
    for (const t of ['REV-2', 'NOTE-3', 'ISO-9001', 'DN-100', 'SHT-1', 'U2-NOTE-4']) {
      expect(parseEquipmentTag(t), t).toBeNull();
    }
  });

  it('a list after the tag is not one tag: equipmentTagsOf reads it', () => {
    expect(parseEquipmentTag('50-P-12A/B')).toBeNull();
    expect(equipmentTagsOf('50-P-12A/B').map((t) => t.tag)).toEqual(['50-P-12A', '50-P-12B']);
    expect(equipmentTagsOf('E-1/2/3').map((t) => t.tag)).toEqual(['E-1', 'E-2', 'E-3']);
    expect(equipmentTagsOf('U2-C-1A-E1A/B').map((t) => t.tag)).toEqual([
      'U2-C-1A-E1A',
      'U2-C-1A-E1B',
    ]);
    expect(equipmentTagsOf('E-101').map((t) => t.tag)).toEqual(['E-101']);
    // An item that does not fit the end of the tag: no tag at all, never half a list.
    expect(equipmentTagsOf('E-101/B')).toEqual([]);
    expect(equipmentTagsOf('P-1A/BCD')).toEqual([]);
    expect(equipmentTagsOf('PT-1234')).toEqual([]);
    expect(equipmentTagsOf('PLAIN')).toEqual([]);
  });

  it('the key joins the two dash forms of one tag', () => {
    expect(tagKey('U2-C-1A-E1A')).toBe('U2C1AE1A');
    expect(tagKey('u2-c-1a-e-1a')).toBe('U2C1AE1A');
    expect(tagKey('E-101')).toBe('E101');
  });

  it('an instrument tag is not an equipment tag', () => {
    expect(parseEquipmentTag('PT-1234')).toBeNull();
  });

  it('TAG_LIKE is the wide net: any dashed token with a letter and a digit', () => {
    expect(TAG_LIKE.test('U2-C-1A-E1')).toBe(true);
    expect(TAG_LIKE.test('E101')).toBe(false);
    expect(TAG_LIKE.test('A-B')).toBe(false);
  });
});

describe('one token form and one order for the three grammars (M2 audit round 1)', () => {
  it('every kind of dash is the one dash, for an instrument, a line number and the wide shape', () => {
    // U+2010 hyphen, U+2013 en dash, U+2212 minus.
    expect(tokensOf('FIC\u2010101 4"\u2013P\u20131001\u2013A1B U2\u2212E\u221212A')).toEqual([
      'FIC-101',
      '4"-P-1001-A1B',
      'U2-E-12A',
    ]);
    const [fic, line, eq] = tokensOf(
      'FIC\u2010101 4"\u2013P\u20131001\u2013A1B U2\u2212E\u221212A',
    );
    expect(tokenKind(fic!)).toBe('instrument');
    expect(tokenKind(line!)).toBe('line');
    expect(tokenKind(eq!)).toBe('equipment');
    expect(TAG_LIKE.test(fic!)).toBe(true);
  });

  it('a tag that ends a sentence is the tag: the full stop is no part of it', () => {
    expect(tokensOf('see P-101A. and FIC-101.')).toEqual(['SEE', 'P-101A', 'AND', 'FIC-101']);
    // A dot inside a token stays (a size).
    expect(tokensOf('1.5"-P-1001-A1B')).toEqual(['1.5"-P-1001-A1B']);
    expect(tokensOf('...')).toEqual([]);
  });

  it('a tag keeps its digits as written, and so does its key', () => {
    expect(parseEquipmentTag('01-P-0101A')).toMatchObject({ tag: '01-P-0101A', unit: '01' });
    expect(tagKey('01-P-0101A')).toBe('01P0101A');
    expect(tagKey('01-P-0101A')).not.toBe(tagKey('1-P-101A'));
    // The key still joins the two dash forms of one tag.
    expect(tagKey('U2-C-1A-E1A')).toBe(tagKey('U2-C-1A-E-1A'));
    // A list with padded numbers is read: the digits are not cut first.
    expect(equipmentTagsOf('P-001/002').map((t) => t.tag)).toEqual(['P-001', 'P-002']);
  });

  it('a token past the length bound is no tag and no line number, however it is shaped', () => {
    const list = `P-1A${'/B'.repeat(TOKEN_MAX_CHARS)}`;
    expect(list.length).toBeGreaterThan(TOKEN_MAX_CHARS);
    expect(tokenKind(list)).toBeNull();
    expect(tokenKind(`4"-P-1001-${'A'.repeat(TOKEN_MAX_CHARS)}`)).toBeNull();
    // Under the bound a list is still read.
    expect(tokenKind('P-1A/B/C')).toBe('equipment');
  });

  it('a date with its month written out is no line number', () => {
    for (const date of ['15-JUNE-2026', '20-JULY-2025', '25-MARCH-2026', '15-SEPTEMBER-2026']) {
      expect(parseLineNumber(date)).toBeNull();
    }
    // A service code that only starts like a month is not a month: 3 letters decide.
    expect(parseLineNumber('4"-MAR-1001-A1B')).toBeNull();
    expect(parseLineNumber('4"-MA-1001-A1B')).not.toBeNull();
  });

  it('a three-part code with an ISA code in the middle is an instrument by the order of trial', () => {
    // It can be a short line number (size, service, serial): the order is
    // fixed and stated, and a site profile is what tells them apart.
    expect(tokenKind('100-FG-2001')).toBe('instrument');
    expect(tokenKind('100-FG-2001-A1B')).toBe('line');
  });

  it('splits a list before the order of trial: instrument tags with a list are read', () => {
    expect(tokenKind('PSV-101A/B')).toBe('instrument');
    expect(tokenKind('XV-1001A/B')).toBe('instrument');
    expect(tokenKind('10-FV-101/102')).toBe('instrument');
    expect(tokenKind('P-1A/B')).toBe('equipment');
    // An item longer than the end it changes: a half-read list would be a
    // wrong tag, so the token is no tag.
    expect(tokenKind('FV-101/1234')).toBeNull();
  });

  it('a line number with a fraction size is a line number, with the whole size', () => {
    const [token] = tokensOf('1½"-P-1001-A1A');
    expect(tokenKind(token!)).toBe('line');
    expect(parseLineNumber(token!)).toMatchObject({ size: '1-1/2"', serial: '1001' });
  });

  it('states two real forms the order puts in another tab', () => {
    // Two-letter equipment codes that are ISA codes are instruments.
    expect(tokenKind('EA-101')).toBe('instrument');
    // A line number with no size part is equipment with a fourth part.
    expect(tokenKind('P-1001-A1A')).toBe('equipment');
  });

  it('tries the whole token first: a line number with a slash in a part stays one line', () => {
    expect(tokenItems('6"-HC-1001-B2A/H')).toEqual({ kind: 'line', items: ['6"-HC-1001-B2A/H'] });
    expect(tokenItems('2"-P-1001-A1A/IH')).toEqual({ kind: 'line', items: ['2"-P-1001-A1A/IH'] });
    expect(tokenItems('PSV-101A/B')).toEqual({
      kind: 'instrument',
      items: ['PSV-101A', 'PSV-101B'],
    });
  });

  it('a list whose items are of two kinds is no tag (stated)', () => {
    // 80-P-200 is equipment (200 is a pipe size), 80-P-201 a line number.
    expect(tokenItems('80-P-200/201')).toBeNull();
  });

  it('joins only a whole inch of 1 to 3 to a fraction: a unit number stays a part', () => {
    expect(parseLineNumber('20-1/2"-P-1001-A1A')).toMatchObject({ size: '1/2"' });
    expect(parseLineNumber('3-1/2"-P-1001-A1A')).toMatchObject({ size: '3-1/2"' });
  });
});

describe('a site profile', () => {
  const EMPTY: SiteProfile = {
    equipmentTypes: [],
    instrumentCodes: [],
    notTags: [],
    lineServices: [],
  };
  const profile = (p: Partial<SiteProfile>): SiteProfile => ({ ...EMPTY, ...p });

  /** Every token of the tests that exist: each quoted literal of these
   *  test files, cut into tokens. */
  const tokensOfTests = (): string[] => {
    const files = ['pdf-tags.test.ts', 'pdf-kind.test.ts'];
    const out = new Set<string>();
    for (const name of files) {
      const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
      for (const m of source.matchAll(/'([^'\n\\]{1,200})'/g)) {
        for (const token of tokensOf(m[1]!)) out.add(token);
      }
    }
    return [...out];
  };

  it('with an empty profile every token reads as with none', () => {
    const tokens = tokensOfTests();
    expect(tokens.length).toBeGreaterThan(200);
    for (const token of tokens) {
      for (const p of [EMPTY, profile({})]) {
        expect(tokenItems(token, p), token).toEqual(tokenItems(token));
        expect(parseInstrumentTag(token, p), token).toEqual(parseInstrumentTag(token));
        expect(parseLineNumber(token, p), token).toEqual(parseLineNumber(token));
        expect(parseEquipmentTag(token, p), token).toEqual(parseEquipmentTag(token));
      }
    }
  });

  it('a profile changes only the tokens its words name', () => {
    const p = profile({ equipmentTypes: ['HX'], notTags: ['ZZ'] });
    for (const token of tokensOfTests()) {
      if (JSON.stringify(tokenItems(token, p)) !== JSON.stringify(tokenItems(token))) {
        expect(token, token).toMatch(/HX|ZZ/);
      }
    }
  });

  it('the first known wrong: EA-101 is equipment with equipmentTypes EA', () => {
    expect(tokenKind('EA-101')).toBe('instrument');
    const p = profile({ equipmentTypes: ['EA'] });
    expect(tokenKind('EA-101', p)).toBe('equipment');
    expect(parseEquipmentTag('EA-101', p)).toMatchObject({ type: 'EA', number: '101' });
    expect(tokenItems('U2-EA-101A/B', p)).toEqual({
      kind: 'equipment',
      items: ['U2-EA-101A', 'U2-EA-101B'],
    });
    // Other ISA codes stay instruments.
    expect(tokenKind('FIC-101', p)).toBe('instrument');
  });

  it('the second known wrong: P-1001-A1A is a line with lineServices P', () => {
    expect(tokenKind('P-1001-A1A')).toBe('equipment');
    const p = profile({ lineServices: ['P'] });
    expect(tokenKind('P-1001-A1A', p)).toBe('line');
    expect(parseLineNumber('P-1001-A1A', p)).toEqual({
      line: 'P-1001-A1A',
      size: '',
      serial: '1001',
    });
    // A line with a size reads as before; a service with no serial is no line.
    expect(parseLineNumber('4"-P-1001-A1A', p)).toEqual(parseLineNumber('4"-P-1001-A1A'));
    expect(parseLineNumber('P-10-A1A', p)).toBeNull();
    expect(tokenKind('P-101', p)).toBe('equipment');
  });

  it('instrument codes are added to the device codes; not-tags words are never a tag', () => {
    expect(parseIsaCode('HCV')).not.toBeNull();
    expect(tokenKind('XYQ-101')).toBe('equipment');
    expect(tokenKind('XYQ-101', profile({ instrumentCodes: ['XYQ'] }))).toBe('instrument');
    expect(tokenKind('FIC-101', profile({ notTags: ['FIC'] }))).toBeNull();
    expect(tokenKind('DRUM-12')).toBe('equipment');
    expect(tokenKind('DRUM-12', profile({ notTags: ['DRUM'] }))).toBeNull();
    // A word in both lists is never a tag.
    expect(tokenKind('EA-101', profile({ equipmentTypes: ['EA'], notTags: ['EA'] }))).toBeNull();
  });

  it('a word is looked up, never read as a pattern', () => {
    const p = profile({
      notTags: ['.*', 'A|B'],
      equipmentTypes: ['.', '[A-Z]'],
      lineServices: ['.'],
    });
    expect(tokenKind('FIC-101', p)).toBe('instrument');
    expect(tokenKind('E-101', p)).toBe('equipment');
    expect(tokenKind('E-101A', p)).toBe('equipment');
    expect(tokenKind('X-1001-A1A', p)).toBe('equipment');
  });
});
