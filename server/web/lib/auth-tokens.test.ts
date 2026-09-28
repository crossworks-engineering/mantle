import { createHmac } from 'node:crypto';
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
 * The retired team-chat kind ('c') is pinned as refused everywhere below.
 */

const SECRET = 'test-secret-test-secret-test-secret-48chars!!';

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

/** Sign claims exactly as lib/auth does, for a kind nothing mints any more. */
function signRaw(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', Buffer.from(SECRET)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

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
    const { verifyTeamVisitorValue } = await authLib();
    for (const bad of ['', 'nodot', 'not-a-token']) {
      expect(verifyTeamVisitorValue(bad)).toBeNull();
    }
  });

  it('rejects a truncated signature (length mismatch, not a timing leak)', async () => {
    const { buildTeamVisitorCookie, verifyTeamVisitorValue } = await authLib();
    const { value } = buildTeamVisitorCookie('share-1', 'contact-9');
    const dot = value.lastIndexOf('.');
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    expect(verifyTeamVisitorValue(`${payload}.${sig.slice(0, 10)}`)).toBeNull();
    expect(verifyTeamVisitorValue(`${payload}.`)).toBeNull();
  });

  it('rejects a valid-length but wrong signature', async () => {
    const { buildTeamVisitorCookie, buildAssetToken, verifyTeamVisitorValue } = await authLib();
    const chat = buildTeamVisitorCookie('share-1', 'contact-9');
    const other = { value: buildAssetToken('user-123456789012') };
    // Graft a well-formed signature of the same length from a different payload.
    const payload = chat.value.slice(0, chat.value.lastIndexOf('.'));
    const foreignSig = other.value.slice(other.value.lastIndexOf('.') + 1);
    expect(verifyTeamVisitorValue(`${payload}.${foreignSig}`)).toBeNull();
  });

  it('rejects a payload that is not JSON, and JSON that is not an object', async () => {
    const { buildTeamVisitorCookie, verifyTeamVisitorValue } = await authLib();
    const { value } = buildTeamVisitorCookie('share-1', 'contact-9');
    const sig = value.slice(value.lastIndexOf('.'));
    const notJson = `${Buffer.from('definitely-not-json').toString('base64url')}${sig}`;
    expect(verifyTeamVisitorValue(notJson)).toBeNull();
    expect(verifyTeamVisitorValue(forgePayload(value, [] as never))).toBeNull();
  });

  it('rejects a tampered payload even when the claims are well formed', async () => {
    const { buildTeamVisitorCookie, verifyTeamVisitorValue } = await authLib();
    const { value } = buildTeamVisitorCookie('share-1', 'contact-9');
    const forged = forgePayload(value, {
      sh: 'share-1',
      cid: 'contact-EVIL',
      exp: 9_999_999_999,
      k: 't',
    });
    expect(verifyTeamVisitorValue(forged)).toBeNull();
  });
});

describe('signed-value spine — expiry', () => {
  it('accepts a live token and rejects one past its exp', async () => {
    const { buildMobileToken, mobileTokenJti } = await authLib();
    expect(mobileTokenJti(buildMobileToken('u1', 'jti-live', 3600).value)).toBe('jti-live');
    expect(mobileTokenJti(buildMobileToken('u1', 'jti-dead', -1).value)).toBeNull();
  });

  it('rejects a token whose exp is present but not a number', async () => {
    const { buildTeamVisitorCookie, verifyTeamVisitorValue } = await authLib();
    const { value } = buildTeamVisitorCookie('share-1', 'contact-9');
    expect(
      verifyTeamVisitorValue(forgePayload(value, { sh: 's', cid: 'c', exp: '9999999999', k: 't' })),
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
      mobileTokenJti,
      verifyTeamVisitorValue,
    } = await authLib();

    const minted = {
      session: buildSessionCookie('u1').value,
      mobile: buildMobileToken('u1', 'jti-1', 3600).value,
      asset: buildAssetToken('u1'),
      visitor: buildTeamVisitorCookie('share-1', 'contact-9').value,
    };

    const verifiers = {
      mobile: (v: string) => mobileTokenJti(v),
      visitor: (v: string) => verifyTeamVisitorValue(v),
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

/**
 * The team-chat credential (kind 'c') was retired with /team, /hub and
 * /api/team/* (member logins Phase 6). A correctly signed, unexpired value of
 * that kind, as an old browser or the client's localStorage may still hold,
 * must open nothing: not a session, a bearer, an asset, a share visitor or a
 * frame ticket.
 */
describe('retired team-chat kind', () => {
  it('every verifier refuses a validly signed kind-c value', async () => {
    const auth = await authLib();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const chat = signRaw({
      own: 'owner-1',
      cid: 'contact-9',
      sh: 'share-1',
      uid: 'u1',
      exp,
      k: 'c',
    });
    expect(auth.verifySessionCookie(chat)).toBeNull();
    expect(auth.mobileTokenJti(chat)).toBeNull();
    expect(auth.verifyAssetToken(chat)).toBeNull();
    expect(auth.verifyTeamVisitorValue(chat)).toBeNull();
    expect(auth.verifyAppFrameTicket(chat)).toBeNull();
    // The helper signs like lib/auth: the same claims as kind 't' DO verify.
    expect(
      auth.verifyTeamVisitorValue(signRaw({ sh: 'share-1', cid: 'contact-9', exp, k: 't' })),
    ).toEqual({ shareId: 'share-1', contactId: 'contact-9' });
  });

  it('the team-chat mint and verify helpers are gone', async () => {
    const auth = (await authLib()) as Record<string, unknown>;
    for (const name of [
      'TEAM_CHAT_COOKIE',
      'buildTeamChatToken',
      'buildTeamChatCookie',
      'verifyTeamChatValue',
    ]) {
      expect(auth[name], name).toBeUndefined();
    }
  });
});
