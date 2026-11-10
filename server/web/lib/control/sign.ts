/**
 * The Control Center's signed call (docs/control-center.md, plan section
 * 2.3). One algorithm, Ed25519, so there is nothing to downgrade to.
 *
 * The CC signs one canonical string:
 *
 *   mantle-control-v1\n METHOD \n path \n box origin \n unix seconds \n sha256 hex of the raw body
 *
 * The box rebuilds it from its own origin (MANTLE_PUBLIC_URL, never a
 * request header) and the raw bytes it read, and checks the signature with
 * the public key in its .env. A call signed for box A fails at box B.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export const CONTROL_PATH = '/api/control/call';
export const CONTROL_TIME_HEADER = 'x-mantle-control-time';
export const CONTROL_SIG_HEADER = 'x-mantle-control-signature';
/** How far the CC's clock may be from the box's, either way. */
export const CONTROL_SKEW_SECONDS = 60;

const KEY_PREFIX = 'ed25519:';
/** The DER head of an Ed25519 SubjectPublicKeyInfo (RFC 8410): the 32 raw
 *  key bytes follow it. */
const SPKI_HEAD = Buffer.from('302a300506032b6570032100', 'hex');
const STD_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

export function canonicalString(origin: string, unixSeconds: number, body: Uint8Array): string {
  const hash = createHash('sha256').update(body).digest('hex');
  return `mantle-control-v1\nPOST\n${CONTROL_PATH}\n${origin}\n${unixSeconds}\n${hash}`;
}

/** The public key of an env line (`ed25519:` + the standard base64 of 32
 *  raw bytes), or null when the line is anything else. */
export function parsePublicKeyLine(line: string): KeyObject | null {
  if (!line.startsWith(KEY_PREFIX)) return null;
  const b64 = line.slice(KEY_PREFIX.length);
  if (!STD_BASE64.test(b64)) return null;
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_HEAD, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** The env line of a public key: `ed25519:` + base64 of its 32 raw bytes. */
export function publicKeyLine(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return KEY_PREFIX + der.subarray(der.length - 32).toString('base64');
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: 'pem' });
}

/** The two headers of a call to `origin` with `body`, signed now. */
export function signCall(
  privateKey: KeyObject,
  origin: string,
  body: Uint8Array,
  now = Date.now(),
): Record<string, string> {
  const t = Math.floor(now / 1000);
  const sig = sign(null, Buffer.from(canonicalString(origin, t, body)), privateKey);
  return { [CONTROL_TIME_HEADER]: String(t), [CONTROL_SIG_HEADER]: sig.toString('base64') };
}

export type VerifyRefusal = 'time' | 'sig';

/** Null when the call is good, else why not. Never parses the body. */
export function verifyCall(
  publicKey: KeyObject,
  origin: string,
  body: Uint8Array,
  timeHeader: string | null,
  sigHeader: string | null,
  now = Date.now(),
): VerifyRefusal | null {
  if (!timeHeader || !/^\d{1,12}$/.test(timeHeader)) return 'time';
  const t = Number(timeHeader);
  if (Math.abs(Math.floor(now / 1000) - t) > CONTROL_SKEW_SECONDS) return 'time';
  if (!sigHeader || !/^[A-Za-z0-9+/]{86}==$/.test(sigHeader)) return 'sig';
  const ok = verify(
    null,
    Buffer.from(canonicalString(origin, t, body)),
    publicKey,
    Buffer.from(sigHeader, 'base64'),
  );
  return ok ? null : 'sig';
}
