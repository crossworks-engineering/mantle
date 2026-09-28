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
 * The retired team-chat ('c') and team-visitor ('t') kinds are pinned as
 * refused everywhere below.
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
    const { verifyAppFrameTicket } = await authLib();
    for (const bad of ['', 'nodot', 'not-a-token']) {
      expect(verifyAppFrameTicket(bad)).toBeNull();
    }
  });

  it('rejects a truncated signature (length mismatch, not a timing leak)', async () => {
    const { buildAppFrameTicket, verifyAppFrameTicket } = await authLib();
    const value = buildAppFrameTicket({ ownerId: 'owner-1', appId: 'app-1', shareId: 'share-1' });
    const dot = value.lastIndexOf('.');
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    expect(verifyAppFrameTicket(`${payload}.${sig.slice(0, 10)}`)).toBeNull();
    expect(verifyAppFrameTicket(`${payload}.`)).toBeNull();
  });

  it('rejects a valid-length but wrong signature', async () => {
    const { buildAppFrameTicket, buildAssetToken, verifyAppFrameTicket } = await authLib();
    const ticket = buildAppFrameTicket({ ownerId: 'owner-1', appId: 'app-1' });
    const other = buildAssetToken('user-123456789012');
    // Graft a well-formed signature of the same length from a different payload.
    const payload = ticket.slice(0, ticket.lastIndexOf('.'));
    const foreignSig = other.slice(other.lastIndexOf('.') + 1);
    expect(verifyAppFrameTicket(`${payload}.${foreignSig}`)).toBeNull();
  });

  it('rejects a payload that is not JSON, and JSON that is not an object', async () => {
    const { buildAppFrameTicket, verifyAppFrameTicket } = await authLib();
    const value = buildAppFrameTicket({ ownerId: 'owner-1', appId: 'app-1' });
    const sig = value.slice(value.lastIndexOf('.'));
    const notJson = `${Buffer.from('definitely-not-json').toString('base64url')}${sig}`;
    expect(verifyAppFrameTicket(notJson)).toBeNull();
    expect(verifyAppFrameTicket(forgePayload(value, [] as never))).toBeNull();
  });

  it('rejects a tampered payload even when the claims are well formed', async () => {
    const { buildAppFrameTicket, verifyAppFrameTicket } = await authLib();
    const value = buildAppFrameTicket({ ownerId: 'owner-1', appId: 'app-1' });
    const forged = forgePayload(value, {
      uid: 'owner-EVIL',
      app: 'app-1',
      exp: 9_999_999_999,
      k: 'f',
    });
    expect(verifyAppFrameTicket(forged)).toBeNull();
  });
});

describe('signed-value spine — expiry', () => {
  it('accepts a live token and rejects one past its exp', async () => {
    const { buildMobileToken, mobileTokenJti } = await authLib();
    expect(mobileTokenJti(buildMobileToken('u1', 'jti-live', 3600).value)).toBe('jti-live');
    expect(mobileTokenJti(buildMobileToken('u1', 'jti-dead', -1).value)).toBeNull();
  });

  it('rejects a token whose exp is present but not a number', async () => {
    const { buildAppFrameTicket, verifyAppFrameTicket } = await authLib();
    const value = buildAppFrameTicket({ ownerId: 'owner-1', appId: 'app-1' });
    expect(
      verifyAppFrameTicket(forgePayload(value, { uid: 'u', app: 'a', exp: '9999999999', k: 'f' })),
    ).toBeNull();
  });
});

/**
 * The isolation matrix. Every mintable credential is fed to every reachable
 * verifier; exactly one cell per row may succeed. A signed value is only ever
 * valid for the surface it was minted for — this is what stops a mobile bearer
 * being pasted into a session cookie (which would dodge mobile_tokens
 * revocation) or an asset token opening an app frame.
 */
describe('kind isolation — no credential is valid on another surface', () => {
  it('each verifier accepts only its own kind', async () => {
    const {
      buildSessionCookie,
      buildMobileToken,
      buildAssetToken,
      buildAppFrameTicket,
      mobileTokenJti,
      verifyAssetToken,
      verifyAppFrameTicket,
    } = await authLib();

    const minted = {
      session: buildSessionCookie('u1').value,
      mobile: buildMobileToken('u1', 'jti-1', 3600).value,
      asset: buildAssetToken('u1'),
      frame: buildAppFrameTicket({ ownerId: 'u1', appId: 'app-1' }),
    };

    const verifiers = {
      mobile: (v: string) => mobileTokenJti(v),
      asset: (v: string) => verifyAssetToken(v),
      frame: (v: string) => verifyAppFrameTicket(v),
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
 * /api/team/* (member logins Phase 6), and the team-visitor cookie (kind 't',
 * `mantle_team`) with team links (stage 6). A correctly signed, unexpired
 * value of either kind, as an old browser may still hold, must open nothing:
 * not a session, a bearer, an asset or a frame ticket.
 */
describe('retired team kinds', () => {
  it('every verifier refuses a validly signed kind-c or kind-t value', async () => {
    const auth = await authLib();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    for (const k of ['c', 't']) {
      const value = signRaw({
        own: 'owner-1',
        cid: 'contact-9',
        sh: 'share-1',
        uid: 'u1',
        app: 'app-1',
        exp,
        k,
      });
      expect(auth.verifySessionCookie(value), k).toBeNull();
      expect(auth.mobileTokenJti(value), k).toBeNull();
      expect(auth.verifyAssetToken(value), k).toBeNull();
      expect(auth.verifyAppFrameTicket(value), k).toBeNull();
    }
    // The helper signs like lib/auth: the same claims as kind 'f' DO verify.
    expect(auth.verifyAppFrameTicket(signRaw({ uid: 'u1', app: 'app-1', exp, k: 'f' }))).toEqual({
      ownerId: 'u1',
      appId: 'app-1',
    });
  });

  it('the team-chat and team-visitor mint and verify helpers are gone', async () => {
    const auth = (await authLib()) as Record<string, unknown>;
    for (const name of [
      'TEAM_CHAT_COOKIE',
      'buildTeamChatToken',
      'buildTeamChatCookie',
      'verifyTeamChatValue',
      'TEAM_VISITOR_COOKIE',
      'buildTeamVisitorCookie',
      'verifyTeamVisitorValue',
    ]) {
      expect(auth[name], name).toBeUndefined();
    }
  });
});

/** A frame ticket carries no team visitor's contact any more (stage 6): the
 *  mint takes none, and one still signed with `cid` does not surface it. */
describe('app-frame tickets carry no contact', () => {
  it('drops a cid claim on verify and mints only the claims it knows', async () => {
    const auth = await authLib();
    const exp = Math.floor(Date.now() / 1000) + 60;
    const old = signRaw({ uid: 'u1', app: 'app-1', sh: 'share-1', cid: 'contact-9', exp, k: 'f' });
    expect(auth.verifyAppFrameTicket(old)).toEqual({
      ownerId: 'u1',
      appId: 'app-1',
      shareId: 'share-1',
    });
    const minted = auth.buildAppFrameTicket({
      ownerId: 'u1',
      appId: 'app-1',
      shareId: 'share-1',
      contactId: 'contact-9',
    } as never);
    const claims = JSON.parse(
      Buffer.from(minted.slice(0, minted.lastIndexOf('.')), 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims.cid).toBeUndefined();
  });
});
