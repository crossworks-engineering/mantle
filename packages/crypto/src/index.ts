import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM at-rest encryption for Mantle's secrets column.
 *
 * Key derivation is intentionally simple: the master key (MANTLE_MASTER_KEY,
 * 32 bytes base64) is the AES key directly. If we ever need per-record keys
 * or HKDF, this is the chokepoint to change. Ciphertext layout is opaque to
 * callers — never persist the parts separately.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_VERSION = 1;

export interface SealedSecret {
  /** Single buffer suitable for a `bytea` column. */
  ciphertext: Buffer;
  /** Key version. Bump and add a branch in `open` when rotating. */
  keyVersion: number;
}

function masterKey(): Buffer {
  const b64 = process.env.MANTLE_MASTER_KEY;
  if (!b64) throw new Error('MANTLE_MASTER_KEY is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error(`MANTLE_MASTER_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/** Encrypt a UTF-8 string. AAD lets callers bind ciphertext to a row id. */
export function seal(plaintext: string, aad?: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: version (1) | iv (12) | tag (16) | ciphertext (n)
  const out = Buffer.concat([Buffer.from([KEY_VERSION]), iv, tag, enc]);
  return { ciphertext: out, keyVersion: KEY_VERSION };
}

export function open(sealed: Buffer, aad?: string): string {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('sealed buffer too short');
  }
  const version = sealed[0];
  if (version !== KEY_VERSION) {
    throw new Error(`unknown key version: ${version}`);
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const enc = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, masterKey(), iv);
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
