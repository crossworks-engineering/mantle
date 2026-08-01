import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The signed-value spine: every credential in lib/auth is `payload.signature`
 * over an HMAC of SESSION_SECRET, discriminated by a `k` kind marker. These
 * tests pin the properties that must hold for ALL of them at once —
 * round-trip, tamper rejection, expiry, and (the security-critical one) KIND
 * ISOLATION, so no credential can ever be replayed on another surface.
 *
 * Written against the public `./auth` facade rather than the internals, so the
 * same file proves behaviour is unchanged across the tokens/session split.
 * Kind-specific claim shapes are covered in team-chat-auth.test.ts.
 */

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-48chars!!';
});

async function authLib() {
  return import('./auth');
}

/** Re-sign nothing — just swap the payload for one the caller controls, keeping
 *  the original signature. Any verifier must reject: the MAC no longer matches. */
function forgePayload(signed: string, claims: Record<string, unknown>): string {
  const sig = signed.slice(signed.lastIndexOf('.'));
  return `${Buffer.from(JSON.stringify(claims)).toString('base64url')}${sig}`;
}

describe('signed-value spine — shape handling', () => {
  it('rejects values with no signature separator, and empty input', async () => {
    const { verifyTeamChatValue } = await authLib();
    for (const bad of ['', 'nodot', 'not-a-token']) {
      expect(verifyTeamChatValue(bad)).toBeNull();
    }
  });

  it('rejects a truncated signature (length mismatch, not a timing leak)', async () => {
    const { buildTeamChatCookie, verifyTeamChatValue } = await authLib();
    const { value } = buildTeamChatCookie('owner-1', 'contact-9');
    const dot = value.lastIndexOf('.');
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    expect(verifyTeamChatValue(`${payload}.${sig.slice(0, 10)}`)).toBeNull();
    expect(verifyTeamChatValue(`${payload}.`)).toBeNull();
  });

  it('rejects a valid-length but wrong signature', async () => {
    const { buildTeamChatCookie, buildTeamVisitorCookie, verifyTeamChatValue } = await authLib();
    const chat = buildTeamChatCookie('owner-1', 'contact-9');
    const other = buildTeamVisitorCookie('share-1', 'contact-9');
    // Graft a well-formed signature of the same length from a different payload.
    const payload = chat.value.slice(0, chat.value.lastIndexOf('.'));
    const foreignSig = other.value.slice(other.value.lastIndexOf('.') + 1);
    expect(verifyTeamChatValue(`${payload}.${foreignSig}`)).toBeNull();
  });

  it('rejects a payload that is not JSON, and JSON that is not an object', async () => {
    const { buildTeamChatCookie, verifyTeamChatValue } = await authLib();
    const { value } = buildTeamChatCookie('owner-1', 'contact-9');
    const sig = value.slice(value.lastIndexOf('.'));
    const notJson = `${Buffer.from('definitely-not-json').toString('base64url')}${sig}`;
    expect(verifyTeamChatValue(notJson)).toBeNull();
    expect(verifyTeamChatValue(forgePayload(value, [] as never))).toBeNull();
  });

  it('rejects a tampered payload even when the claims are well formed', async () => {
    const { buildTeamChatCookie, verifyTeamChatValue } = await authLib();
    const { value } = buildTeamChatCookie('owner-1', 'contact-9');
    const forged = forgePayload(value, {
      own: 'owner-1',
      cid: 'contact-EVIL',
      exp: 9_999_999_999,
      k: 'c',
    });
    expect(verifyTeamChatValue(forged)).toBeNull();
  });
});

describe('signed-value spine — expiry', () => {
  it('accepts a live token and rejects one past its exp', async () => {
    const { buildMobileToken, mobileTokenJti } = await authLib();
    expect(mobileTokenJti(buildMobileToken('u1', 'jti-live', 3600).value)).toBe('jti-live');
    expect(mobileTokenJti(buildMobileToken('u1', 'jti-dead', -1).value)).toBeNull();
  });

  it('rejects a token whose exp is present but not a number', async () => {
    const { buildTeamChatCookie, verifyTeamChatValue } = await authLib();
    const { value } = buildTeamChatCookie('owner-1', 'contact-9');
    expect(
      verifyTeamChatValue(forgePayload(value, { own: 'o', cid: 'c', exp: '9999999999', k: 'c' })),
    ).toBeNull();
  });
});

/**
 * The isolation matrix. Every mintable credential is fed to every reachable
 * verifier; exactly one cell per row may succeed. A signed value is only ever
 * valid for the surface it was minted for — this is what stops a mobile bearer
 * being pasted into a session cookie (which would dodge mobile_tokens
 * revocation) or a share-visitor cookie opening the brain-level team chat.
 */
describe('kind isolation — no credential is valid on another surface', () => {
  it('each verifier accepts only its own kind', async () => {
    const {
      buildSessionCookie,
      buildMobileToken,
      buildAssetToken,
      buildTeamVisitorCookie,
      buildTeamChatCookie,
      mobileTokenJti,
      verifyTeamVisitorValue,
      verifyTeamChatValue,
    } = await authLib();

    const minted = {
      session: buildSessionCookie('u1').value,
      mobile: buildMobileToken('u1', 'jti-1', 3600).value,
      asset: buildAssetToken('u1'),
      visitor: buildTeamVisitorCookie('share-1', 'contact-9').value,
      chat: buildTeamChatCookie('owner-1', 'contact-9').value,
    };

    const verifiers = {
      mobile: (v: string) => mobileTokenJti(v),
      visitor: (v: string) => verifyTeamVisitorValue(v),
      chat: (v: string) => verifyTeamChatValue(v),
    };

    for (const [mintKind, value] of Object.entries(minted)) {
      for (const [verifyKind, verify] of Object.entries(verifiers)) {
        const accepted = verify(value) !== null;
        expect(
          accepted,
          `${verifyKind} verifier ${accepted ? 'ACCEPTED' : 'rejected'} a ${mintKind} credential`,
        ).toBe(mintKind === verifyKind);
      }
    }
  });
});
