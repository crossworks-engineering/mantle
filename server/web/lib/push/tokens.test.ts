// Tests for the Mantle-side instance-token primitives. hashToken MUST stay
// byte-identical to mantle-push/src/lib/tokens.ts — the relay stores this hash
// and derives the ticket key from it, so a drift here silently breaks every
// enrollment against the live relay. We pin it to known SHA-256 vectors.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateInstanceToken, hashToken } from './tokens';

describe('generateInstanceToken', () => {
  it('is a 256-bit, URL-safe, unpadded base64url secret', () => {
    const t = generateInstanceToken();
    expect(Buffer.from(t, 'base64url').length).toBe(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).toHaveLength(43);
  });

  it('does not repeat across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateInstanceToken());
    expect(seen.size).toBe(2000);
  });
});

describe('hashToken', () => {
  it('matches known SHA-256 vectors (utf8 input) — the relay-compat contract', () => {
    expect(hashToken('').toString('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hashToken('abc').toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns 32 raw bytes, deterministic, and equals a plain node sha256', () => {
    const tok = generateInstanceToken();
    expect(hashToken(tok)).toHaveLength(32);
    expect(hashToken(tok).equals(hashToken(tok))).toBe(true);
    expect(hashToken(tok).equals(createHash('sha256').update(tok, 'utf8').digest())).toBe(true);
  });

  it('distinct inputs produce distinct hashes', () => {
    expect(hashToken('a').equals(hashToken('b'))).toBe(false);
  });
});
