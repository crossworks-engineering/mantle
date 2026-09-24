import { describe, expect, it } from 'vitest';
import {
  classifyEntry,
  deriveContactTitle,
  digitsOnly,
  formatCell,
  hasIdentity,
  isPlausibleEmail,
  isPlausibleEmailOrDomain,
  normalizeCountryCode,
  normalizeEmail,
  normalizeEmailEntries,
  normalizeEmailEntry,
  partitionEmailEntries,
  toE164,
} from './contacts';

describe('digitsOnly', () => {
  it('strips non-digits but preserves order', () => {
    expect(digitsOnly('(760) 810-0774')).toBe('7608100774');
    expect(digitsOnly('+27 76 081 0774')).toBe('27760810774');
    expect(digitsOnly('')).toBe('');
  });
});

describe('normalizeCountryCode', () => {
  it.each([
    ['+27', '+27'],
    ['27', '+27'],
    [' +44 ', '+44'],
    ['00 27', '+27'],
    ['+1', '+1'],
    ['+1234', '+1234'],
  ])('normalises %s → %s', (raw, want) => {
    expect(normalizeCountryCode(raw)).toBe(want);
  });

  it.each(['', '   ', 'abc', '+', '+12345', '0'])('rejects %p', (bad) => {
    // 5-digit "country code" is too long; "0" alone has the "00" prefix
    // stripper apply to "0" → "" which falls below min length.
    expect(normalizeCountryCode(bad)).toBe('');
  });
});

describe('toE164', () => {
  it('joins normalised country code + digits-only cell', () => {
    expect(toE164('+27', '760810774')).toBe('+27760810774');
    expect(toE164('27', '(76) 081 0774')).toBe('+27760810774');
  });
  it('returns empty when either part is missing', () => {
    expect(toE164('', '760810774')).toBe('');
    expect(toE164('+27', '')).toBe('');
  });
});

describe('formatCell', () => {
  it('groups from the right: 4 then 3s, with country code prefix', () => {
    expect(formatCell('+27', '760810774')).toBe('+27 76 081 0774');
    expect(formatCell('+44', '7700900123')).toBe('+44 770 090 0123');
    expect(formatCell('+1', '4155551234')).toBe('+1 415 555 1234');
  });
  it('handles short numbers gracefully', () => {
    expect(formatCell('+27', '1234')).toBe('+27 1234');
    expect(formatCell('+27', '12345')).toBe('+27 1 2345');
  });
  it('returns empty when both parts missing', () => {
    expect(formatCell('', '')).toBe('');
  });
});

describe('normalizeEmail', () => {
  it('lower-cases + trims', () => {
    expect(normalizeEmail('  Jason@Example.COM  ')).toBe('jason@example.com');
  });
});

describe('isPlausibleEmail', () => {
  it.each(['a@b.co', 'jason@example.com', 'orders+sales@modular.co.za'])('accepts %s', (e) => {
    expect(isPlausibleEmail(e)).toBe(true);
  });
  it.each(['', 'no-at', 'no@dot', '@no-local.com', 'spaces in@x.com'])('rejects %p', (bad) => {
    expect(isPlausibleEmail(bad)).toBe(false);
  });
});

describe('hasIdentity', () => {
  it('accepts a first name alone', () => {
    expect(hasIdentity({ firstName: 'Jane' })).toBe(true);
  });
  it('accepts a last name alone', () => {
    expect(hasIdentity({ lastName: 'Smith' })).toBe(true);
  });
  it('accepts a company alone (org/supplier contact)', () => {
    expect(hasIdentity({ company: 'Modular' })).toBe(true);
  });
  it('rejects an entirely empty input (e.g. a blank draft on save)', () => {
    expect(hasIdentity({})).toBe(false);
    expect(hasIdentity({ firstName: '', lastName: '', company: '' })).toBe(false);
    // Email/cell alone do NOT satisfy — they're channels, not identities.
    // (No properties on the input type for them, but if extra keys leak in
    // the function only inspects the three identity slots.)
  });
  it('treats whitespace-only as empty', () => {
    expect(hasIdentity({ firstName: '   ', company: '\t\n' })).toBe(false);
  });
});

describe('deriveContactTitle', () => {
  it('prefers "First Last" when set', () => {
    expect(deriveContactTitle({ firstName: 'John', lastName: 'Smith' })).toBe('John Smith');
  });
  it('keeps the first name alone for single names', () => {
    expect(deriveContactTitle({ firstName: 'Jane' })).toBe('Jane');
  });
  it('uses company when set and no person name', () => {
    expect(deriveContactTitle({ company: 'Modular' })).toBe('Modular');
  });
  it('person name beats company when both are set', () => {
    // Company is surfaced separately in the UI; the row title is the person.
    expect(deriveContactTitle({ firstName: 'Jane', lastName: 'Smith', company: 'Modular' })).toBe(
      'Jane Smith',
    );
  });
  it('falls back to email when name + company are empty', () => {
    expect(deriveContactTitle({ email: 'orders@modular.co.za' })).toBe('orders@modular.co.za');
  });
  it('falls back to formatted cell when name + company + email empty', () => {
    expect(deriveContactTitle({ countryCode: '+27', cell: '760810774' })).toBe('+27 76 081 0774');
  });
  it('returns "Untitled contact" when nothing fits (e.g. a freshly created draft)', () => {
    expect(deriveContactTitle({})).toBe('Untitled contact');
  });
  it('falls back to the first email entry', () => {
    expect(deriveContactTitle({ emails: ['jason@example.com', '@x.com'] })).toBe(
      'jason@example.com',
    );
  });
});

describe('classifyEntry', () => {
  it.each(['jason@example.com', 'a@b.co', 'orders+sales@modular.co.za', '  Jason@Example.COM  '])(
    'classifies %p as address',
    (e) => expect(classifyEntry(e)).toBe('address'),
  );
  it.each(['@example.com', '@x.co.za', ' @Example.COM '])('classifies %p as domain', (e) =>
    expect(classifyEntry(e)).toBe('domain'),
  );
  it.each(['', 'example.com', '@', '@nodot', 'no-at', 'spaces in@x.com', '@-bad.com'])(
    'classifies %p as invalid',
    (e) => expect(classifyEntry(e)).toBe('invalid'),
  );
});

describe('normalizeEmailEntry', () => {
  it('lower-cases + trims an address', () => {
    expect(normalizeEmailEntry('  Jason@Example.COM ')).toBe('jason@example.com');
  });
  it('canonicalises a domain wildcard with leading @', () => {
    expect(normalizeEmailEntry(' @Example.COM ')).toBe('@example.com');
  });
  it('returns "" for invalid input (incl. bare domain)', () => {
    expect(normalizeEmailEntry('example.com')).toBe('');
    expect(normalizeEmailEntry('garbage')).toBe('');
  });
});

describe('isPlausibleEmailOrDomain', () => {
  it.each(['jason@example.com', '@example.com'])('accepts %p', (e) =>
    expect(isPlausibleEmailOrDomain(e)).toBe(true),
  );
  it.each(['', 'example.com', '@', 'nope'])('rejects %p', (e) =>
    expect(isPlausibleEmailOrDomain(e)).toBe(false),
  );
});

describe('normalizeEmailEntries', () => {
  it('normalises, de-dupes, and drops invalid entries', () => {
    expect(
      normalizeEmailEntries(['Jason@Example.com', 'jason@example.com', '@X.com', 'garbage', '']),
    ).toEqual(['jason@example.com', '@x.com']);
  });
});

describe('partitionEmailEntries', () => {
  it('splits concrete addresses from @domain wildcards (bare domain returned)', () => {
    const { addresses, domains } = partitionEmailEntries([
      'jason@example.com',
      '@example.com',
      'BOB@x.com',
      '@x.com',
      'garbage',
    ]);
    expect(addresses).toEqual(['jason@example.com', 'bob@x.com']);
    expect(domains).toEqual(['example.com', 'x.com']);
  });
  it('handles empty / undefined', () => {
    expect(partitionEmailEntries(undefined)).toEqual({ addresses: [], domains: [] });
  });
});
