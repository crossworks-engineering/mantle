/**
 * Tests for the pure federation token helpers. The security property we lock
 * down: the inbound token is only ever recoverable as its hash, the hash is
 * deterministic, and verification is a constant-time compare that rejects
 * mismatches and malformed stored hashes.
 */
import { describe, expect, it } from 'vitest';
import { PEER_TOKEN_PREFIX, hashToken, mintInboundToken, tokenMatchesHash } from './peers-crypto';

describe('mintInboundToken', () => {
  it('carries the recognisable prefix', () => {
    expect(mintInboundToken().startsWith(PEER_TOKEN_PREFIX)).toBe(true);
  });

  it('is unique across mints (CSPRNG)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mintInboundToken());
    expect(seen.size).toBe(1000);
  });

  it('has meaningful entropy beyond the prefix', () => {
    const body = mintInboundToken().slice(PEER_TOKEN_PREFIX.length);
    expect(body.length).toBeGreaterThanOrEqual(40); // 32 bytes base64url ≈ 43
  });
});

describe('hashToken', () => {
  it('is deterministic', () => {
    expect(hashToken('mtlpeer_abc')).toBe(hashToken('mtlpeer_abc'));
  });

  it('is a 64-char hex SHA-256', () => {
    expect(hashToken('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs (no trivial collision)', () => {
    expect(hashToken('mtlpeer_a')).not.toBe(hashToken('mtlpeer_b'));
  });
});

describe('tokenMatchesHash', () => {
  it('accepts the token that produced the hash', () => {
    const t = mintInboundToken();
    expect(tokenMatchesHash(t, hashToken(t))).toBe(true);
  });

  it('rejects a wrong token', () => {
    const t = mintInboundToken();
    expect(tokenMatchesHash(mintInboundToken(), hashToken(t))).toBe(false);
  });

  it('rejects a malformed / wrong-length stored hash without throwing', () => {
    const t = mintInboundToken();
    expect(tokenMatchesHash(t, 'not-a-hash')).toBe(false);
    expect(tokenMatchesHash(t, '')).toBe(false);
  });
});
