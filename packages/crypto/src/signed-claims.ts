import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@mantle/config';

/**
 * The signing spine every Mantle credential shares (moved here from
 * server/web/lib/auth/tokens.ts so a package can mint a render cookie for the
 * documents engine without the web tier): HMAC-SHA256 of a base64url JSON
 * payload under SESSION_SECRET, a `k` kind and an `exp`. The verifiers stay in
 * the web tier; this file holds the two primitives and the derived key.
 *
 * Stateless by design: there is no session table. Rotating SESSION_SECRET
 * invalidates every value at once.
 */

/** The `k` claim: mobile bearer, asset token, app frame, render cookie,
 *  contact visitor (contact shares), app tool confirmation. 'c' (the retired
 *  team-chat credential) and 't' (the retired team-visitor cookie) are
 *  reserved: no verifier takes them. */
export type TokenKind = 'm' | 'a' | 'f' | 'r' | 'v' | 'q';

/**
 * Claims whose signature, kind and expiry have already been checked. Every
 * field beyond `exp` is still untrusted in SHAPE: each verifier narrows the
 * claims it cares about before handing them to a caller.
 */
export type SignedClaims = Record<string, unknown> & { exp: number };

function secret(): Buffer {
  const s = env('SESSION_SECRET');
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET must be set (>=32 chars). Run `openssl rand -base64 48`.');
  }
  return Buffer.from(s);
}

/**
 * A key for one purpose, derived from SESSION_SECRET (HMAC with the purpose
 * as the message): local to this brain, never sent anywhere, and never the
 * signing key itself. Rotating SESSION_SECRET rotates it.
 */
export function derivedSecret(purpose: string): Buffer {
  return createHmac('sha256', secret()).update(`mantle-derived:${purpose}`).digest();
}

export function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

/**
 * Mint a signed value: `claims` plus an `exp` of `ttlSeconds` from now, encoded
 * and signed. Returns the value and the absolute expiry, since several callers
 * report the latter back to a client.
 */
export function signClaims(
  claims: Record<string, unknown>,
  ttlSeconds: number,
): { value: string; exp: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64urlEncode(Buffer.from(JSON.stringify({ ...claims, exp }), 'utf8'));
  const sig = createHmac('sha256', secret()).update(payload).digest();
  return { value: `${payload}.${b64urlEncode(sig)}`, exp };
}

/**
 * The verification spine every credential shares: constant-time signature
 * check, kind check, expiry check. Returns the decoded claims, or null if the
 * value is malformed, forged, of the wrong kind, or expired.
 *
 * `kind` is null for the session cookie only: the kindless shape. Keeping the
 * two cases explicit (rather than collapsing them) is deliberate: `k: null` in
 * a payload must NOT satisfy the session check, and an exact comparison is the
 * only form where that reads unambiguously.
 */
export function verifySigned(value: string, kind: TokenKind | null): SignedClaims | null {
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = value.slice(0, dot);
  const expected = createHmac('sha256', secret()).update(payload).digest();
  const got = b64urlDecode(value.slice(dot + 1));
  if (got.length !== expected.length) return null;
  if (!timingSafeEqual(got, expected)) return null;

  try {
    const data: unknown = JSON.parse(b64urlDecode(payload).toString('utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const claims = data as Record<string, unknown>;

    if (kind === null) {
      if (claims.k !== undefined) return null;
    } else if (claims.k !== kind) {
      return null;
    }

    const exp = claims.exp;
    if (typeof exp !== 'number') return null;
    if (Date.now() / 1000 > exp) return null;
    return { ...claims, exp };
  } catch {
    return null;
  }
}
