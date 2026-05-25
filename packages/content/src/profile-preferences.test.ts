import { describe, expect, it } from 'vitest';
import { isRecipientAllowed } from './profile-preferences';

describe('isRecipientAllowed', () => {
  const own = ['jason@schoeman.me'];

  it('is OFF when the allowlist is empty/undefined — allows anyone', () => {
    expect(isRecipientAllowed('stranger@evil.com', undefined, own)).toBe(true);
    expect(isRecipientAllowed('stranger@evil.com', [], own)).toBe(true);
  });

  it('always allows the user\'s own account addresses, even when gated', () => {
    expect(isRecipientAllowed('jason@schoeman.me', ['@crossworks.net'], own)).toBe(true);
    expect(isRecipientAllowed('JASON@SCHOEMAN.ME', ['@crossworks.net'], own)).toBe(true);
  });

  it('allows an exact-address allowlist entry', () => {
    expect(isRecipientAllowed('besties@crossworks.net', ['besties@crossworks.net'], own)).toBe(true);
    expect(isRecipientAllowed('other@crossworks.net', ['besties@crossworks.net'], own)).toBe(false);
  });

  it('allows a whole-domain @entry', () => {
    expect(isRecipientAllowed('anyone@crossworks.net', ['@crossworks.net'], own)).toBe(true);
    expect(isRecipientAllowed('anyone@elsewhere.com', ['@crossworks.net'], own)).toBe(false);
  });

  it('refuses a non-listed recipient when the gate is on', () => {
    expect(isRecipientAllowed('stranger@evil.com', ['@crossworks.net'], own)).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    expect(isRecipientAllowed('Besties@CrossWorks.net', ['BESTIES@crossworks.NET'], own)).toBe(true);
    expect(isRecipientAllowed('x@CROSSWORKS.net', ['@crossworks.net'], own)).toBe(true);
  });

  it('handles blank recipients', () => {
    expect(isRecipientAllowed('', ['@crossworks.net'], own)).toBe(false);
  });
});
