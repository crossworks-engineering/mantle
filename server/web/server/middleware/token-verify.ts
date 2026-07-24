/**
 * Signed-token checks for the gate middleware — a faithful port of the
 * verify/tokenKind pair from the old Edge middleware.ts (same Web Crypto API,
 * which Node ships natively). Per-request auth still happens in lib/auth.ts;
 * this only gates non-public paths on a syntactically-valid, signed, unexpired
 * credential of the right kind.
 */

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function eqConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Signature + expiry check. Malformed input resolves to `false`, never throws —
 *  an attacker-controlled Bearer value must produce a clean 401, not a 500. */
export async function verifySignedToken(token: string, secret: string): Promise<boolean> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const payload = token.slice(0, dot);
    const sigPart = token.slice(dot + 1);

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
    );
    const got = b64urlDecode(sigPart);
    if (!eqConstantTime(got, expected)) return false;

    const json = new TextDecoder().decode(b64urlDecode(payload));
    const data = JSON.parse(json);
    if (typeof data.exp !== 'number') return false;
    if (Date.now() / 1000 > data.exp) return false;
    return true;
  } catch {
    return false;
  }
}

/** The kind marker (`k`) in a token's payload, or null. Cookies carry none;
 *  mobile bearers carry `'m'`, asset tokens `'a'`. Signature/expiry are checked
 *  separately by `verifySignedToken`. */
export function tokenKind(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  try {
    const k = JSON.parse(new TextDecoder().decode(b64urlDecode(token.slice(0, dot)))).k;
    return typeof k === 'string' ? k : null;
  } catch {
    return null;
  }
}
