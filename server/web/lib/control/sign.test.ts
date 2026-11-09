/**
 * The Control Center's signed call (docs/control-center.md, plan section
 * 2.3): one canonical string, Ed25519, the box's own origin, 60 seconds.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_SIG_HEADER,
  CONTROL_TIME_HEADER,
  canonicalString,
  parsePublicKeyLine,
  publicKeyLine,
  signCall,
  verifyCall,
} from './sign';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const line = publicKeyLine(publicKey);
const pub = parsePublicKeyLine(line)!;
const body = Buffer.from('{"op":"hello"}');
const ORIGIN = 'https://box.example.invalid';

describe('the signed call', () => {
  it('signs the fixed string over the raw body', () => {
    const hash = createHash('sha256').update(body).digest('hex');
    expect(canonicalString(ORIGIN, 100, body)).toBe(
      `mantle-control-v1\nPOST\n/api/control/call\n${ORIGIN}\n100\n${hash}`,
    );
  });

  it('a good call passes', () => {
    const h = signCall(privateKey, ORIGIN, body);
    expect(
      verifyCall(pub, ORIGIN, body, h[CONTROL_TIME_HEADER]!, h[CONTROL_SIG_HEADER]!),
    ).toBeNull();
  });

  it('refuses another origin, another body, another key', () => {
    const h = signCall(privateKey, ORIGIN, body);
    const t = h[CONTROL_TIME_HEADER]!;
    const s = h[CONTROL_SIG_HEADER]!;
    expect(verifyCall(pub, 'https://other.example.invalid', body, t, s)).toBe('sig');
    expect(verifyCall(pub, ORIGIN, Buffer.from('{"op":"logins"}'), t, s)).toBe('sig');
    const other = parsePublicKeyLine(publicKeyLine(generateKeyPairSync('ed25519').publicKey))!;
    expect(verifyCall(other, ORIGIN, body, t, s)).toBe('sig');
    expect(verifyCall(pub, ORIGIN, body, t, null)).toBe('sig');
    expect(verifyCall(pub, ORIGIN, body, t, 'not base64')).toBe('sig');
  });

  it('refuses a time more than 60 seconds off, either way', () => {
    const now = Date.now();
    for (const off of [61_000, -61_000]) {
      const h = signCall(privateKey, ORIGIN, body, now + off);
      expect(
        verifyCall(pub, ORIGIN, body, h[CONTROL_TIME_HEADER]!, h[CONTROL_SIG_HEADER]!, now),
      ).toBe('time');
    }
    const ok = signCall(privateKey, ORIGIN, body, now - 59_000);
    expect(
      verifyCall(pub, ORIGIN, body, ok[CONTROL_TIME_HEADER]!, ok[CONTROL_SIG_HEADER]!, now),
    ).toBeNull();
    expect(verifyCall(pub, ORIGIN, body, null, ok[CONTROL_SIG_HEADER]!, now)).toBe('time');
    expect(verifyCall(pub, ORIGIN, body, '12x', ok[CONTROL_SIG_HEADER]!, now)).toBe('time');
  });

  it('reads only ed25519: and 32 bytes of standard base64', () => {
    expect(parsePublicKeyLine(line)).not.toBeNull();
    expect(parsePublicKeyLine(line.replace('ed25519:', 'ED25519:'))).toBeNull();
    expect(parsePublicKeyLine(line.slice('ed25519:'.length))).toBeNull();
    expect(parsePublicKeyLine(`ed25519:${Buffer.alloc(31).toString('base64')}`)).toBeNull();
    expect(parsePublicKeyLine(`ed25519:${Buffer.alloc(33).toString('base64')}`)).toBeNull();
    expect(parsePublicKeyLine(`ed25519:${'-'.repeat(43)}=`)).toBeNull();
    expect(parsePublicKeyLine(`${line} `)).toBeNull();
  });
});
