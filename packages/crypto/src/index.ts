import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM at-rest encryption for Mantle's sealed columns
 * (api_keys.key_enc, emails account passwords, telegram bot tokens,
 * secrets.ciphertext).
 *
 * Key derivation is intentionally simple: the master key (a 32-byte
 * base64 string in MANTLE_MASTER_KEY) is the AES key directly. If we
 * ever need per-record keys or HKDF, this file is the chokepoint to
 * change. Ciphertext layout is opaque to callers — never persist the
 * parts separately.
 *
 * Rotation: a new key can be staged via MANTLE_MASTER_KEY_NEXT while
 * the old one stays in MANTLE_MASTER_KEY. `seal()` always uses the
 * "current" key; `open()` will accept ciphertext sealed under either
 * (matched by the version byte in the header). After a re-seal pass
 * — `scripts/rotate-master-key.ts` — every row is on the new key and
 * the env vars can be swapped (NEXT → CURRENT, drop the old).
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Version byte stored at the front of every ciphertext. We bump this
 *  on rotation so a row sealed under the old key is identifiable. */
const KEY_VERSION_V1 = 1;
const KEY_VERSION_V2 = 2;
/** What `seal()` writes today. Flipped from 1 → 2 during a rotation. */
const CURRENT_VERSION = (process.env.MANTLE_MASTER_KEY_NEXT ? KEY_VERSION_V2 : KEY_VERSION_V1) as
  | 1
  | 2;

export interface SealedSecret {
  /** Single buffer suitable for a `bytea` column. */
  ciphertext: Buffer;
  /** Key version this blob was sealed under. */
  keyVersion: number;
}

function parseB64Key(b64: string, label: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/** The key `seal()` uses for new ciphertext. During rotation that's
 *  the NEW key; in steady state it's MANTLE_MASTER_KEY. */
function currentKey(): Buffer {
  const next = process.env.MANTLE_MASTER_KEY_NEXT;
  if (next) return parseB64Key(next, 'MANTLE_MASTER_KEY_NEXT');
  const b64 = process.env.MANTLE_MASTER_KEY;
  if (!b64) throw new Error('MANTLE_MASTER_KEY is not set');
  return parseB64Key(b64, 'MANTLE_MASTER_KEY');
}

/** Key resolver for `open()`. Returns the key bound to a given version
 *  byte, or null if we don't have it configured (caller throws). */
function keyForVersion(version: number): Buffer | null {
  const cur = process.env.MANTLE_MASTER_KEY;
  const next = process.env.MANTLE_MASTER_KEY_NEXT;
  if (version === KEY_VERSION_V1) {
    // v1 is whichever key holds the not-yet-rotated ciphertext. During
    // rotation that's MANTLE_MASTER_KEY (the old one); in steady state
    // that's also MANTLE_MASTER_KEY (no rotation underway).
    return cur ? parseB64Key(cur, 'MANTLE_MASTER_KEY') : null;
  }
  if (version === KEY_VERSION_V2) {
    // v2 was sealed under the new key, which lives in NEXT during a
    // rotation. After the rotation completes, the operator swaps env:
    // NEXT → CURRENT and drops the old. Once swapped, v2 is in
    // MANTLE_MASTER_KEY and NEXT is unset.
    if (next) return parseB64Key(next, 'MANTLE_MASTER_KEY_NEXT');
    if (cur) return parseB64Key(cur, 'MANTLE_MASTER_KEY');
    return null;
  }
  return null;
}

/** Encrypt a UTF-8 string. AAD lets callers bind ciphertext to a row id. */
export function seal(plaintext: string, aad?: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, currentKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: version (1) | iv (12) | tag (16) | ciphertext (n)
  const out = Buffer.concat([Buffer.from([CURRENT_VERSION]), iv, tag, enc]);
  return { ciphertext: out, keyVersion: CURRENT_VERSION };
}

export function open(sealed: Buffer, aad?: string): string {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('sealed buffer too short');
  }
  const version = sealed[0]!;
  const key = keyForVersion(version);
  if (!key) {
    throw new Error(
      `unknown key version ${version} — set MANTLE_MASTER_KEY (and MANTLE_MASTER_KEY_NEXT if mid-rotation)`,
    );
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const enc = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Encrypt a JSON-serialisable value. */
export function sealJSON<T>(value: T, aad?: string): SealedSecret {
  return seal(JSON.stringify(value), aad);
}

export function openJSON<T>(sealed: Buffer, aad?: string): T {
  return JSON.parse(open(sealed, aad)) as T;
}

/** Read the version byte of an already-sealed buffer. Used by the
 *  rotation script to decide which rows still need re-sealing. */
export function sealedKeyVersion(sealed: Buffer): number {
  if (sealed.length < 1) return 0;
  return sealed[0]!;
}

/** The version `seal()` is currently producing. Exposed for tooling
 *  (the rotation script asserts it's V2 before walking the tables). */
export function currentSealVersion(): number {
  return CURRENT_VERSION;
}
