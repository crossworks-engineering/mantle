import { describe, expect, it } from 'vitest';
import {
  deriveContactTitle,
  digitsOnly,
  formatCell,
  isPlausibleEmail,
  normalizeCountryCode,
  normalizeEmail,
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
    expect(normalizeEmail('  Jason@Schoeman.ME  ')).toBe('jason@schoeman.me');
  });
});

describe('isPlausibleEmail', () => {
  it.each(['a@b.co', 'jason@schoeman.me', 'orders+sales@modular.co.za'])('accepts %s', (e) => {
    expect(isPlausibleEmail(e)).toBe(true);
  });
  it.each(['', 'no-at', 'no@dot', '@no-local.com', 'spaces in@x.com'])('rejects %p', (bad) => {
    expect(isPlausibleEmail(bad)).toBe(false);
  });
});

describe('deriveContactTitle', () => {
  it('prefers "First Last" when set', () => {
    expect(deriveContactTitle({ firstName: 'John', lastName: 'Smith' })).toBe('John Smith');
  });
  it('keeps the first name alone for orgs/single names', () => {
    expect(deriveContactTitle({ firstName: 'Modular' })).toBe('Modular');
  });
  it('falls back to email when name is empty', () => {
    expect(deriveContactTitle({ email: 'orders@modular.co.za' })).toBe('orders@modular.co.za');
  });
  it('falls back to formatted cell when name + email empty', () => {
    expect(deriveContactTitle({ countryCode: '+27', cell: '760810774' })).toBe('+27 76 081 0774');
  });
  it('returns "Untitled contact" when nothing fits', () => {
    expect(deriveContactTitle({})).toBe('Untitled contact');
  });
});
