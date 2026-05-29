/**
 * Pure token helpers for federation peer auth. No DB, no @mantle/crypto —
 * just node:crypto — so vitest can exercise them in isolation (same split as
 * events-time.ts / contacts-format.ts).
 *
 * Two directions, two treatments (see docs/federation.md):
 *  - the OUTBOUND token (the one a peer gave us) is sealed elsewhere via
 *    @mantle/crypto because we must replay it;
 *  - the INBOUND token (the one we mint for a peer) is only ever stored as the
 *    SHA-256 produced here — we show the plaintext once and keep the hash.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Human-recognisable prefix so a leaked token is obviously a Mantle peer key. */
export const PEER_TOKEN_PREFIX = 'mtlpeer_';

/**
 * Mint a fresh inbound token to hand to a peer: prefix + 32 bytes of CSPRNG as
 * base64url (~43 chars). Returned plaintext is shown to the operator exactly
 * once; only `hashToken(it)` is persisted.
 */
export function mintInboundToken(): string {
  return PEER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** SHA-256 (hex) of a token. Deterministic — the verification key. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time compare of a presented token against a stored hash. Equivalent
 * to `hashToken(presented) === stored`, but the timingSafeEqual guards against
 * a timing side-channel on the hash comparison. Length-mismatched / malformed
 * stored hashes return false rather than throwing.
 */
export function tokenMatchesHash(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(presented), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
