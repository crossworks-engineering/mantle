/**
 * SCIM settings (docs/scim.md): one bearer token per box, kept as its sha256,
 * read at each call. The box .env names it (MANTLE_SCIM_TOKEN_HASH), or the
 * setup screen made it and the setup row keeps it (docs/oidc-sign-in.md). The
 * token itself lives only in the identity provider.
 *
 *   MANTLE_SCIM_TOKEN_HASH | Mode word                | Answer
 *   64 hex characters      | any                      | on, that hash, no read
 *   any other value        | any                      | off, no read (the stop)
 *   empty                  | off                      | off, no read
 *   empty                  | setup, optional, required| one read of the row
 *
 * Off is the default and the hard rule (corporate plan section 2.1): with
 * the value empty and the mode off, every SCIM route answers 404 and nothing
 * here reads the database. A value that is not 64 hex characters is off too,
 * logged once (`off` itself says nothing): a half-set box never lets a
 * provider in. A read that fails throws, so a route answers its error, never
 * the 404 of SCIM off.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env, oidcModeWord } from '@mantle/config';
import { isUuid } from '@mantle/std';
import { ssoSetupRow } from '@/lib/oidc/store';

/** A sha256 in hex: what the .env value and the setup row must hold. */
export const HASH_RE = /^[0-9a-f]{64}$/i;

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

let warned = false;
function warnOnce(text: string): void {
  if (warned) return;
  warned = true;
  void import('@mantle/tracing').then(({ log }) => log('auth').warn(text));
}

/** The token's hash now, by the table above, or null: SCIM is off. */
export async function scimTokenHash(): Promise<Buffer | null> {
  const raw = (env('MANTLE_SCIM_TOKEN_HASH') ?? '').trim();
  if (raw !== '') {
    if (raw.toLowerCase() === 'off') return null;
    if (!HASH_RE.test(raw)) {
      warnOnce(
        'MANTLE_SCIM_TOKEN_HASH is not 64 hex characters (a sha256): SCIM stays off. Make one with pnpm -C server/web scim-token.',
      );
      return null;
    }
    return Buffer.from(raw, 'hex');
  }
  if (oidcModeWord() === 'off') return null;
  const stored = (await ssoSetupRow())?.scimTokenHash ?? '';
  if (stored === '') return null;
  if (!HASH_RE.test(stored)) {
    warnOnce('The setup row holds a SCIM token hash that is not a sha256: SCIM stays off.');
    return null;
  }
  return Buffer.from(stored, 'hex');
}

/** Whether SCIM is on now. */
export async function scimOn(): Promise<boolean> {
  return (await scimTokenHash()) !== null;
}

/** Whether `presented` is the token whose hash is `hash`, in constant time. */
export function scimTokenMatches(presented: string, hash: Buffer): boolean {
  return presented !== '' && timingSafeEqual(sha256(presented), hash);
}

/** A new token (256 random bits) and the hash the .env or the setup row
 *  keeps. */
export function newScimToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token).toString('hex') };
}

let warnedLink = false;

/**
 * Whether a company sign-in may link a login SCIM made by the provider's
 * object id (MANTLE_SCIM_AUTO_LINK, docs/scim.md "Signing in the first
 * time"). Off unless the .env says on, and then only while SCIM is on; the
 * caller asks company sign-in itself (it runs inside its callback). Any
 * other word is off, logged once.
 */
export async function scimAutoLinkOn(): Promise<boolean> {
  const raw = (env('MANTLE_SCIM_AUTO_LINK') ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return false;
  if (raw !== 'on' && raw !== 'true' && raw !== '1' && raw !== 'yes') {
    if (!warnedLink) {
      warnedLink = true;
      void import('@mantle/tracing').then(({ log }) =>
        log('auth').warn('MANTLE_SCIM_AUTO_LINK is not on or off: it stays off.'),
      );
    }
    return false;
  }
  return scimOn();
}

/** Entra's sign-in hosts: the public cloud, US Government, China. */
const ENTRA_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoftonline.us',
  'login.partner.microsoftonline.cn',
]);

/**
 * The tenant the company sign-in issuer names: the first path part of
 * MANTLE_OIDC_ISSUER that is a GUID (Entra's
 * `https://login.microsoftonline.com/<tenant id>/v2.0`), lower case, or null
 * for an issuer that names none or is not one of Entra's hosts (no
 * auto-link there).
 */
export function issuerTenant(issuer: string): string | null {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  // Entra's own sign-in hosts only: their tokens' tid and oid are Entra's,
  // not claims another provider lets a user or an admin set.
  if (url.protocol !== 'https:' || !ENTRA_HOSTS.has(url.hostname.toLowerCase())) return null;
  const part = url.pathname.split('/').find((p) => isUuid(p));
  return part ? part.toLowerCase() : null;
}

/** Whether `v` is a GUID (an Entra object or tenant id). */
export function isGuid(v: string | null | undefined): v is string {
  return isUuid(v);
}
