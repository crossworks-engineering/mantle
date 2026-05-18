/**
 * Vitest suite for the crypto chokepoint. Every encrypted-at-rest
 * column in Mantle (api_keys, secrets, email/telegram credentials)
 * goes through these eight lines. A silent bug here would be a silent
 * data-loss bug, so we test:
 *
 *   - Roundtrip with and without AAD.
 *   - AAD mismatch refuses to decrypt (binds ciphertext to a row id).
 *   - Truncated / corrupt / wrong-version ciphertext throws.
 *   - The two-key rotation flow: stage NEXT, open v1+v2, finalise.
 *   - JSON helpers preserve shape.
 *
 * We import `seal`/`open` etc. lazily inside `withEnv()` so module
 * initialisation reads the env vars we just set rather than the
 * snapshot at first import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// 32-byte base64 keys for the suite. Hardcoded so failures are
// reproducible — never use these elsewhere.
const KEY_OLD = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const KEY_NEW = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Wipe both vars so each test sets exactly what it needs.
  delete process.env.MANTLE_MASTER_KEY;
  delete process.env.MANTLE_MASTER_KEY_NEXT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/**
 * Each test that depends on env-controlled module state (notably
 * `CURRENT_VERSION`, captured at import time) needs a fresh module
 * copy. `vi.resetModules()` clears the cache so the next dynamic
 * import re-evaluates the module against the env we just set.
 */
async function freshModule() {
  vi.resetModules();
  return (await import('./index')) as typeof import('./index');
}

describe('seal/open roundtrip', () => {
  it('round-trips a plain string with no AAD', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, open } = await freshModule();
    const { ciphertext } = seal('hunter2');
    expect(open(ciphertext)).toBe('hunter2');
  });

  it('round-trips empty string', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, open } = await freshModule();
    const { ciphertext } = seal('');
    expect(open(ciphertext)).toBe('');
  });

  it('round-trips multi-byte unicode', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, open } = await freshModule();
    const plaintext = '🔐 Jason — über/sécret — 中文 العربية';
    const { ciphertext } = seal(plaintext);
    expect(open(ciphertext)).toBe(plaintext);
  });

  it('round-trips a long payload', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, open } = await freshModule();
    const plaintext = randomBytes(64_000).toString('base64');
    const { ciphertext } = seal(plaintext);
    expect(open(ciphertext)).toBe(plaintext);
  });

  it('two seals of the same plaintext produce distinct ciphertexts', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal } = await freshModule();
    const a = seal('hunter2').ciphertext;
    const b = seal('hunter2').ciphertext;
    expect(a.equals(b)).toBe(false);
  });
});

describe('AAD binding', () => {
  it('round-trips when AAD matches', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, open } = await freshModule();
    const { ciphertext } = seal('hunter2', 'row-id-123');
    expect(open(ciphertext, 'row-id-123')).toBe('hunter2');
  });

  it('refuses to decrypt with a different AAD', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, open } = await freshModule();
    const { ciphertext } = seal('hunter2', 'row-id-123');
    expect(() => open(ciphertext, 'row-id-456')).toThrow();
  });

  it('refuses to decrypt when AAD was set on seal but omitted on open', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, open } = await freshModule();
    const { ciphertext } = seal('hunter2', 'row-id-123');
    expect(() => open(ciphertext)).toThrow();
  });
});

describe('tamper resistance', () => {
  it('refuses to decrypt a truncated buffer', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { open } = await freshModule();
    expect(() => open(Buffer.from([1, 2, 3]))).toThrow(/too short/);
  });

  it('refuses to decrypt when the ciphertext byte is flipped', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, open } = await freshModule();
    const { ciphertext } = seal('hunter2');
    // Flip the last byte of the ciphertext payload, leave headers intact.
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => open(tampered)).toThrow();
  });

  it('refuses to decrypt when the auth tag is flipped', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, open } = await freshModule();
    const { ciphertext } = seal('hunter2');
    // Auth tag lives at bytes 13..28 (after version=1 byte + iv=12).
    const tampered = Buffer.from(ciphertext);
    tampered[15] = tampered[15]! ^ 0xff;
    expect(() => open(tampered)).toThrow();
  });

  it('refuses an unknown version byte', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { open } = await freshModule();
    // Header version 9 doesn't exist in either V1 or V2.
    const fake = Buffer.concat([
      Buffer.from([9]),
      randomBytes(12), // iv
      randomBytes(16), // tag
      randomBytes(16), // ct
    ]);
    expect(() => open(fake)).toThrow(/unknown key version/i);
  });
});

describe('env validation', () => {
  it('throws when MANTLE_MASTER_KEY is missing and no NEXT is set', async () => {
    const { seal } = await freshModule();
    expect(() => seal('x')).toThrow(/MANTLE_MASTER_KEY/);
  });

  it('throws when MANTLE_MASTER_KEY decodes to the wrong length', async () => {
    process.env.MANTLE_MASTER_KEY = Buffer.from('too-short').toString('base64');
    const { seal } = await freshModule();
    expect(() => seal('x')).toThrow(/32 bytes/);
  });
});

describe('rotation flow (v1 → v2)', () => {
  it('seals under v1 when only MANTLE_MASTER_KEY is set', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { seal, sealedKeyVersion, currentSealVersion } = await freshModule();
    expect(currentSealVersion()).toBe(1);
    const { ciphertext, keyVersion } = seal('legacy');
    expect(keyVersion).toBe(1);
    expect(sealedKeyVersion(ciphertext)).toBe(1);
  });

  it('seals under v2 once MANTLE_MASTER_KEY_NEXT is staged', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    process.env.MANTLE_MASTER_KEY_NEXT = KEY_NEW;
    const { seal, sealedKeyVersion, currentSealVersion } = await freshModule();
    expect(currentSealVersion()).toBe(2);
    const { ciphertext, keyVersion } = seal('fresh');
    expect(keyVersion).toBe(2);
    expect(sealedKeyVersion(ciphertext)).toBe(2);
  });

  it('opens v1 ciphertext mid-rotation using the old key', async () => {
    // Phase 1: pre-rotation, write a v1 row.
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const oldMod = await freshModule();
    const v1ct = oldMod.seal('legacy', 'row-1').ciphertext;

    // Phase 2: NEXT is staged. The writer is on v2, but the old
    // ciphertext still has to decrypt.
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    process.env.MANTLE_MASTER_KEY_NEXT = KEY_NEW;
    const midMod = await freshModule();
    expect(midMod.open(v1ct, 'row-1')).toBe('legacy');
  });

  it('opens v2 ciphertext mid-rotation using the new key', async () => {
    // Write a v2 row mid-rotation.
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    process.env.MANTLE_MASTER_KEY_NEXT = KEY_NEW;
    const mid = await freshModule();
    const v2ct = mid.seal('fresh', 'row-2').ciphertext;
    expect(mid.open(v2ct, 'row-2')).toBe('fresh');
  });

  it('opens v2 ciphertext post-rotation (env swapped, NEXT cleared)', async () => {
    // Write v2 mid-rotation.
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    process.env.MANTLE_MASTER_KEY_NEXT = KEY_NEW;
    const mid = await freshModule();
    const v2ct = mid.seal('fresh', 'row-3').ciphertext;

    // Phase 3: operator swaps env. NEW moves to MANTLE_MASTER_KEY,
    // old is dropped. v2 ciphertext should still decrypt.
    process.env.MANTLE_MASTER_KEY = KEY_NEW;
    delete process.env.MANTLE_MASTER_KEY_NEXT;
    const post = await freshModule();
    expect(post.open(v2ct, 'row-3')).toBe('fresh');
  });

  it('refuses to open v1 ciphertext post-rotation (old key gone)', async () => {
    // Pre-rotation v1.
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const pre = await freshModule();
    const v1ct = pre.seal('legacy', 'row-4').ciphertext;

    // Phase 3 with NO rotation script run: the v1 row is now
    // unreadable. This is the correct behaviour — the script
    // MUST run before the env swap.
    process.env.MANTLE_MASTER_KEY = KEY_NEW;
    delete process.env.MANTLE_MASTER_KEY_NEXT;
    const post = await freshModule();
    expect(() => post.open(v1ct, 'row-4')).toThrow();
  });
});

describe('JSON helpers', () => {
  it('round-trips objects', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { sealJSON, openJSON } = await freshModule();
    const obj = { user: 'jason', when: 1717000000, tags: ['work', 'home'] };
    const { ciphertext } = sealJSON(obj, 'aad');
    expect(openJSON(ciphertext, 'aad')).toEqual(obj);
  });

  it('round-trips through arrays at the top level', async () => {
    process.env.MANTLE_MASTER_KEY = KEY_OLD;
    const { sealJSON, openJSON } = await freshModule();
    const arr = [1, 'two', { three: 3 }, null];
    const { ciphertext } = sealJSON(arr, 'aad');
    expect(openJSON(ciphertext, 'aad')).toEqual(arr);
  });
});
