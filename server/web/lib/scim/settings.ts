/**
 * SCIM settings (docs/scim.md): one bearer token per box, kept in the box
 * .env as its sha256 (MANTLE_SCIM_TOKEN_HASH, decision D2), read at each
 * call as `env` is. The token itself lives only in the identity provider.
 *
 * Off is the default and the hard rule (corporate plan section 2.1): with
 * the value empty, every SCIM route answers 404 and nothing here reads the
 * database. A value that is not 64 hex characters is off too, logged once:
 * a half-set box never lets a provider in.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@mantle/config';

const HASH_RE = /^[0-9a-f]{64}$/i;

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

let warned = false;
function warnOnce(text: string): void {
  if (warned) return;
  warned = true;
  void import('@mantle/tracing').then(({ log }) => log('auth').warn(text));
}

/** The token's hash the box .env names, or null: SCIM is off. */
export function scimTokenHash(): Buffer | null {
  const raw = (env('MANTLE_SCIM_TOKEN_HASH') ?? '').trim();
  if (raw === '') return null;
  if (!HASH_RE.test(raw)) {
    warnOnce(
      'MANTLE_SCIM_TOKEN_HASH is not 64 hex characters (a sha256): SCIM stays off. Make one with pnpm -C server/web scim-token.',
    );
    return null;
  }
  return Buffer.from(raw, 'hex');
}

/** Whether SCIM is on now. */
export function scimOn(): boolean {
  return scimTokenHash() !== null;
}

/** Whether `presented` is the token whose hash is `hash`, in constant time. */
export function scimTokenMatches(presented: string, hash: Buffer): boolean {
  return presented !== '' && timingSafeEqual(sha256(presented), hash);
}

/** A new token (256 random bits) and the hash the .env keeps. */
export function newScimToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token).toString('hex') };
}
