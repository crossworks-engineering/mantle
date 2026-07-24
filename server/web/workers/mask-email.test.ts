/**
 * Tests for the email-masking helper used by the email-sync worker's
 * structured logging. We care that:
 *
 *   - The full local-part never appears verbatim.
 *   - The domain is preserved (operators need to match accounts).
 *   - Edge cases (null, missing @, short local-part) don't crash and
 *     don't leak the raw input.
 */

import { describe, expect, it } from 'vitest';
import { maskEmail } from './mask-email';

describe('maskEmail', () => {
  it('masks the local-part to first + stars + last', () => {
    expect(maskEmail('jason@schoeman.me')).toBe('j***n@schoeman.me');
  });

  it('caps the number of stars at 6 for very long local-parts', () => {
    expect(maskEmail('abcdefghijklmnop@example.com')).toBe('a******p@example.com');
  });

  it('reduces a 2-char local-part to a single star (never the raw chars)', () => {
    expect(maskEmail('jq@example.com')).toBe('*@example.com');
  });

  it('reduces a 1-char local-part to a single star', () => {
    expect(maskEmail('j@example.com')).toBe('*@example.com');
  });

  it('handles a 3-char local-part with one star between first and last', () => {
    expect(maskEmail('foo@example.com')).toBe('f*o@example.com');
  });

  it('returns (none) for null', () => {
    expect(maskEmail(null)).toBe('(none)');
  });

  it('returns (none) for undefined', () => {
    expect(maskEmail(undefined)).toBe('(none)');
  });

  it('returns (none) for empty string', () => {
    expect(maskEmail('')).toBe('(none)');
  });

  it('returns *** for strings without @', () => {
    expect(maskEmail('not-an-email')).toBe('***');
  });

  it('returns *** for "@example.com" (no local-part)', () => {
    expect(maskEmail('@example.com')).toBe('***');
  });

  it('never returns the original string verbatim for a real address', () => {
    const addr = 'sensitive.user@example.com';
    expect(maskEmail(addr)).not.toBe(addr);
    expect(maskEmail(addr)).not.toContain('sensitive.user');
  });
});
