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
      buildRenderToken,
      mobileTokenJti,
      verifyAssetToken,
      verifyAppFrameTicket,
      verifyRenderToken,
      verifySessionCookie,
    } = await authLib();

    const minted = {
      session: buildSessionCookie('u1').value,
      mobile: buildMobileToken('u1', 'jti-1', 3600).value,
      asset: buildAssetToken('u1'),
      frame: buildAppFrameTicket({ ownerId: 'u1', appId: 'app-1' }),
      render: buildRenderToken({ ownerId: 'u1', actorId: 'u2', nodeId: 'n1' }),
    };

    const verifiers = {
      session: (v: string) => verifySessionCookie(v),
      mobile: (v: string) => mobileTokenJti(v),
      asset: (v: string) => verifyAssetToken(v),
      frame: (v: string) => verifyAppFrameTicket(v),
      render: (v: string) => verifyRenderToken(v),
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
 * The render cookie (audit F01): what the browser sidecar carries to print an
 * export. It used to be a full kindless session for the anchor; it must now
 * name the acting admin and the node, and never open a session.
 */
describe('render cookies', () => {
  it('carry the anchor, the acting admin and the node, and are never a session', async () => {
    const auth = await authLib();
    const value = auth.buildRenderToken({
      ownerId: 'anchor',
      actorId: 'admin-2',
      nodeId: 'page-1',
    });
    expect(auth.verifyRenderToken(value)).toEqual({ uid: 'anchor', act: 'admin-2', n: 'page-1' });
    expect(auth.verifySessionCookie(value)).toBeNull();
    // A kind-r value missing a claim is refused, not defaulted.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(auth.verifyRenderToken(signRaw({ uid: 'anchor', n: 'page-1', exp, k: 'r' }))).toBeNull();
    expect(auth.verifyRenderToken(signRaw({ uid: 'anchor', act: 'a', exp, k: 'r' }))).toBeNull();
    // Short-lived: gone after its ttl.
    const dead = auth.buildRenderToken({
      ownerId: 'anchor',
      actorId: 'admin-2',
      nodeId: 'page-1',
      ttlSeconds: -1,
    });
    expect(auth.verifyRenderToken(dead)).toBeNull();
  });

  it('the kindless internal render cookie helper is gone', async () => {
    const auth = (await authLib()) as Record<string, unknown>;
    expect(auth.buildInternalRenderCookie).toBeUndefined();
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

/** A CLIENT's frame ticket (client logins C6) carries the login and its
 *  session epoch; an epoch without a login, or one that is not a
 *  non-negative integer, makes the ticket invalid (never a ticket that reads
 *  as a member's). */
describe('client app-frame tickets', () => {
  it('round-trips the login and the epoch, epoch 0 included', async () => {
    const auth = await authLib();
    for (const epoch of [0, 7]) {
      const t = auth.buildAppFrameTicket({
        ownerId: 'u1',
        appId: 'app-1',
        loginId: 'login-1',
        clientEpoch: epoch,
      });
      expect(auth.verifyAppFrameTicket(t)).toEqual({
        ownerId: 'u1',
        appId: 'app-1',
        loginId: 'login-1',
        clientEpoch: epoch,
      });
    }
    // A member's ticket has no epoch.
    const member = auth.buildAppFrameTicket({ ownerId: 'u1', appId: 'app-1', loginId: 'login-1' });
    expect(auth.verifyAppFrameTicket(member)).toEqual({
      ownerId: 'u1',
      appId: 'app-1',
      loginId: 'login-1',
    });
  });

  it('refuses an epoch without a login and an epoch that is not a whole number', async () => {
    const auth = await authLib();
    const exp = Math.floor(Date.now() / 1000) + 60;
    for (const cep of [-1, 1.5, '2', null]) {
      const bad = signRaw({ uid: 'u1', app: 'app-1', mem: 'login-1', cep, exp, k: 'f' });
      expect(auth.verifyAppFrameTicket(bad), String(cep)).toBeNull();
    }
    const orphan = signRaw({ uid: 'u1', app: 'app-1', cep: 0, exp, k: 'f' });
    expect(auth.verifyAppFrameTicket(orphan)).toBeNull();
  });

  it('names the admin login on an owner ticket only (app identity: host.me())', async () => {
    const auth = await authLib();
    const owner = auth.buildAppFrameTicket({ ownerId: 'u1', appId: 'app-1', actorId: 'admin-1' });
    expect(auth.verifyAppFrameTicket(owner)).toEqual({
      ownerId: 'u1',
      appId: 'app-1',
      actorId: 'admin-1',
    });
    // A share or login ticket already says who runs the app: no actor.
    const share = auth.buildAppFrameTicket({
      ownerId: 'u1',
      appId: 'app-1',
      shareId: 's1',
      actorId: 'admin-1',
    });
    expect(auth.verifyAppFrameTicket(share)?.actorId).toBeUndefined();
    const member = auth.buildAppFrameTicket({
      ownerId: 'u1',
      appId: 'app-1',
      loginId: 'login-1',
      actorId: 'admin-1',
    });
    expect(auth.verifyAppFrameTicket(member)?.actorId).toBeUndefined();
    // A hand-signed act on a member ticket is ignored too.
    const exp = Math.floor(Date.now() / 1000) + 60;
    const forged = signRaw({
      uid: 'u1',
      app: 'app-1',
      mem: 'login-1',
      act: 'admin-1',
      exp,
      k: 'f',
    });
    expect(auth.verifyAppFrameTicket(forged)?.actorId).toBeUndefined();
  });
});

/**
 * The session epoch (0181, final audit F06): cookies and asset tokens carry
 * the login's epoch when minted, so the session layer can end them all by
 * bumping it. A value from before 0181 has no claim and reads as 0; a claim
 * that is not a non-negative integer makes the value invalid.
 */
describe('session epoch claim', () => {
  it('round-trips on the session cookie and the asset token', async () => {
    const { buildSessionCookie, verifySessionCookie, buildAssetToken, verifyAssetToken } =
      await authLib();
    expect(verifySessionCookie(buildSessionCookie('u1', { epoch: 4 }).value)?.ep).toBe(4);
    expect(verifySessionCookie(buildSessionCookie('u1').value)?.ep).toBe(0);
    expect(verifyAssetToken(buildAssetToken('u1', 'l1', 7))?.ep).toBe(7);
    expect(verifyAssetToken(buildAssetToken('u1'))?.ep).toBe(0);
  });

  it('reads a value without the claim as epoch 0', async () => {
    const { verifySessionCookie, verifyAssetToken } = await authLib();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(verifySessionCookie(signRaw({ uid: 'u1', exp }))).toEqual({ uid: 'u1', exp, ep: 0 });
    expect(verifyAssetToken(signRaw({ uid: 'u1', exp, k: 'a' }))?.ep).toBe(0);
  });

  it('refuses a value whose claim is not a non-negative integer', async () => {
    const { verifySessionCookie, verifyAssetToken } = await authLib();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    for (const ep of [-1, 1.5, '2', null, true]) {
      expect(verifySessionCookie(signRaw({ uid: 'u1', exp, ep })), String(ep)).toBeNull();
      expect(verifyAssetToken(signRaw({ uid: 'u1', exp, ep, k: 'a' })), String(ep)).toBeNull();
    }
  });
});

/** An admin's review TEST ticket (workspace review pattern): `rv` only with
 *  an admin actor and no share or login; a forged combination fails. */
describe('review test frame tickets', () => {
  it('carries reviewTest only on an owner ticket that names the admin', async () => {
    const auth = await authLib();
    const t = auth.buildAppFrameTicket({
      ownerId: 'u1',
      appId: 'a1',
      actorId: 'l1',
      reviewTest: true,
    });
    expect(auth.verifyAppFrameTicket(t)).toEqual({
      ownerId: 'u1',
      appId: 'a1',
      actorId: 'l1',
      reviewTest: true,
    });
    // No actor, or a member's or a share's ticket: the builder never marks it.
    for (const opts of [{}, { loginId: 'm1' }, { shareId: 's1' }]) {
      const plain = auth.buildAppFrameTicket({
        ownerId: 'u1',
        appId: 'a1',
        reviewTest: true,
        ...opts,
      });
      expect(auth.verifyAppFrameTicket(plain)?.reviewTest).toBeUndefined();
    }
    const owner = auth.buildAppFrameTicket({ ownerId: 'u1', appId: 'a1', actorId: 'l1' });
    expect(auth.verifyAppFrameTicket(owner)?.reviewTest).toBeUndefined();
  });

  it('refuses a forged rv: without an actor, beside a login or a share, or not 1', async () => {
    const auth = await authLib();
    const exp = Math.floor(Date.now() / 1000) + 60;
    for (const extra of [
      { rv: 1 },
      { rv: 1, act: 'l1', mem: 'm1' },
      { rv: 1, act: 'l1', sh: 's1' },
      { rv: 2, act: 'l1' },
      { rv: true, act: 'l1' },
    ]) {
      const bad = signRaw({ uid: 'u1', app: 'a1', exp, k: 'f', ...extra });
      expect(auth.verifyAppFrameTicket(bad), JSON.stringify(extra)).toBeNull();
    }
  });
});
