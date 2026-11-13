/**
 * The one-time keys of the Fleet users invite (invite-keys.ts) and the box's
 * lock (invite-channel.ts): the box locks the code to the public key, the
 * web process opens it once with the private key it holds, and nothing
 * opens it after that or after the keep.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { generateInviteCode } from '@mantle/content';
import {
  INVITE_KEY_KEEP_MS,
  dropInviteKey,
  forgetInviteKeys,
  holdInviteKey,
  holdsInviteKey,
  newInviteKey,
  openInviteAnswer,
} from './invite-keys';
import { inviteKey, lockCode } from './invite-channel';

const CALL = '6f1d2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const BOX = { boxId: 'b0b0b0b0-1111-4222-8333-444455556666', boxUrl: 'https://box.example.invalid/x' };
const EXPIRES = '2026-11-16T09:00:00.000Z';

afterEach(() => forgetInviteKeys());

function held() {
  const pair = newInviteKey()!;
  holdInviteKey(CALL, { key: pair.key, ...BOX, email: 'a@example.com' });
  return pair;
}

describe('the invite key', () => {
  it('the box locks the code to the key; the web opens it once into the link', () => {
    const pair = held();
    const code = generateInviteCode();
    const sealed = lockCode(inviteKey(pair.publicKey)!, code);
    expect(sealed).not.toContain(code);
    expect(holdsInviteKey(CALL.toUpperCase())).toBe(true);
    const got = openInviteAnswer(CALL, { ok: true, output: { sealed, expiresAt: EXPIRES } });
    expect(got).toEqual({
      callId: CALL,
      boxId: BOX.boxId,
      email: 'a@example.com',
      ok: true,
      link: `https://box.example.invalid/invite#code=${code}`,
      expiresAt: EXPIRES,
    });
    // Once: the key is gone.
    expect(holdsInviteKey(CALL)).toBe(false);
    expect(openInviteAnswer(CALL, { ok: true, output: { sealed, expiresAt: EXPIRES } })).toBeNull();
  });

  it('a refusal passes its reason; a locked text that is no code is bad-reply', () => {
    held();
    expect(openInviteAnswer(CALL, { ok: false, reason: 'email-has-login' })).toMatchObject({
      ok: false,
      reason: 'email-has-login',
    });
    const pair = held();
    const sealed = lockCode(inviteKey(pair.publicKey)!, 'javascript:alert(1)');
    expect(openInviteAnswer(CALL, { ok: true, output: { sealed, expiresAt: EXPIRES } })).toMatchObject(
      { ok: false, reason: 'bad-reply' },
    );
    // Locked to another key: it does not open.
    held();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const wrong = lockCode(other, generateInviteCode());
    expect(openInviteAnswer(CALL, { ok: true, output: { sealed: wrong, expiresAt: EXPIRES } })).toMatchObject(
      { ok: false, reason: 'bad-reply' },
    );
  });

  it('a key is dropped after its keep, or when its call is gone', () => {
    let now = 1_000_000;
    forgetInviteKeys(() => now);
    held();
    now += INVITE_KEY_KEEP_MS + 1;
    expect(holdsInviteKey(CALL)).toBe(false);
    forgetInviteKeys(() => now);
    held();
    dropInviteKey(CALL);
    expect(holdsInviteKey(CALL)).toBe(false);
  });

  it('the box takes only an RSA key of 2048 to 4096 bits', () => {
    const spki = (k: import('node:crypto').KeyObject) =>
      k.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(inviteKey(newInviteKey()!.publicKey)).not.toBeNull();
    expect(inviteKey(spki(generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey))).toBeNull();
    expect(inviteKey(spki(generateKeyPairSync('ed25519').publicKey))).toBeNull();
    expect(inviteKey('not a key')).toBeNull();
  });
});
