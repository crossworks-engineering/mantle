// The stored-key check a send prunes on (notify.ts): only a key that is not
// a key at all is pruned, never one libsodium failed to seal to.
import { describe, expect, it } from 'vitest';
import { generateDeviceKeypair, openSealed, publicKeyValid, sealToDevice } from './seal';

describe('publicKeyValid', () => {
  it('accepts a real device public key (standard base64 of 32 bytes)', async () => {
    const { publicKey, secretKey } = await generateDeviceKeypair();
    expect(publicKeyValid(publicKey)).toBe(true);
    const sealed = await sealToDevice(publicKey, 'hello');
    expect(await openSealed(sealed, publicKey, secretKey)).toBe('hello');
  });

  it('refuses what is not a 32-byte key in standard base64', () => {
    // 0xfb bytes encode with both `+` and `/`, so the url-safe case changes.
    const k32 = Buffer.alloc(32, 0xfb).toString('base64');
    expect(k32).toMatch(/[+/]/);
    expect(publicKeyValid(k32)).toBe(true);
    for (const bad of [
      '',
      'broken',
      Buffer.alloc(31, 7).toString('base64'),
      Buffer.alloc(33, 7).toString('base64'),
      k32.replace(/=$/, ''), // no padding
      k32.replace(/\+|\//g, '-'), // url-safe alphabet
      `${k32.slice(0, 43)}!`,
    ]) {
      expect(publicKeyValid(bad)).toBe(false);
    }
  });
});
