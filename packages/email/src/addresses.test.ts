import { describe, expect, it } from 'vitest';
import { domainOf, parseAddress, parseAddressList } from './addresses';

describe('parseAddress', () => {
  it('parses bare addresses', () => {
    expect(parseAddress('jason@example.com')).toEqual({ address: 'jason@example.com' });
  });

  it('parses RFC-5322 quoted-name format', () => {
    expect(parseAddress('"Jason Botha" <jason@example.com>')).toEqual({
      address: 'jason@example.com',
      name: 'Jason Botha',
    });
  });

  it('parses unquoted-name format', () => {
    expect(parseAddress('Jason Botha <jason@example.com>')).toEqual({
      address: 'jason@example.com',
      name: 'Jason Botha',
    });
  });

  it('lowercases the address but preserves the display name', () => {
    expect(parseAddress('Jason <JASON@Example.COM>')).toEqual({
      address: 'jason@example.com',
      name: 'Jason',
    });
  });

  it('rejects strings without @', () => {
    expect(parseAddress('not an email')).toBeUndefined();
  });

  it('rejects empty input', () => {
    expect(parseAddress('')).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(parseAddress('  jason@example.com  ')).toEqual({ address: 'jason@example.com' });
  });
});

describe('parseAddressList', () => {
  it('splits on commas not inside angle brackets', () => {
    const list = parseAddressList('"Jason, J." <jason@example.com>, bob@example.com');
    expect(list).toEqual([
      { address: 'jason@example.com', name: 'Jason, J.' },
      { address: 'bob@example.com' },
    ]);
  });

  it('drops malformed entries instead of throwing', () => {
    const list = parseAddressList('valid@example.com, garbage, also@example.com');
    expect(list.map((a) => a.address)).toEqual(['valid@example.com', 'also@example.com']);
  });

  it('accepts an array input', () => {
    expect(parseAddressList(['a@example.com', 'b@example.com'])).toEqual([
      { address: 'a@example.com' },
      { address: 'b@example.com' },
    ]);
  });

  it('returns empty array for undefined', () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe('domainOf', () => {
  it('returns the domain after the last @', () => {
    expect(domainOf('jason@example.com')).toBe('example.com');
  });

  it('lowercases the domain', () => {
    expect(domainOf('jason@EXAMPLE.COM')).toBe('example.com');
  });

  it('returns empty string when there is no @', () => {
    expect(domainOf('plainstring')).toBe('');
  });

  it('handles addresses with multiple @ by taking the last one', () => {
    // Not RFC-compliant but defensive — some real-world headers contain them.
    expect(domainOf('odd@quoted@example.com')).toBe('example.com');
  });
});
