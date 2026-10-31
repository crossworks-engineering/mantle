/**
 * Handing a company sign-in to a client (handoff.ts), with no database: where
 * a flow may end, the PKCE check, the start ticket, and the company mark on a
 * device bearer. Through the app on Postgres: oidc-handoff.db.test.ts.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signClaims } from '@mantle/crypto';
import { buildMobileToken, verifyMobileToken } from '@/lib/auth/tokens';
import { ownCookieOpts } from '@/lib/auth/own-device';
import {
  APP_REDIRECT,
  WEB_REDIRECT_PATH,
  consentBinding,
  handoffCodeUrl,
  handoffFailedUrl,
  handoffTarget,
  mustAsk,
  newHandoffCode,
  handoffCodeHash,
  readHandoff,
  readStartTicket,
  signStartTicket,
  verifierMatches,
} from './handoff';
import { bearerSessionKind, DEVICE_BEARER } from './hold';
import type { OidcOn } from './settings';

vi.mock('./store', () => {
  const noRead = () => {
    throw new Error('read while off');
  };
  return { loginLinked: noRead, loginHasPassword: noRead, spendHandoffCode: noRead };
});

const BRAIN = 'https://brain.example.invalid';
const s = { mode: 'optional', redirectUri: `${BRAIN}/api/auth/oidc/callback` } as OidcOn;
const VERIFIER = 'a'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

describe('where a flow may end', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'oidc-handoff-test-secret-at-least-32-chars';
    delete process.env.MANTLE_CLIENT_ORIGIN;
    delete process.env.MANTLE_API_CORS_ORIGINS;
  });
  afterEach(() => {
    delete process.env.MANTLE_CLIENT_ORIGIN;
    delete process.env.MANTLE_API_CORS_ORIGINS;
  });

  it('takes the app target and the web page on the brain itself', () => {
    expect(handoffTarget(s, APP_REDIRECT)).toBe('mantle://oidc');
    expect(handoffTarget(s, `${BRAIN}/auth/oidc`)).toBe(`${BRAIN}/auth/oidc`);
    expect(WEB_REDIRECT_PATH).toBe('/auth/oidc');
  });

  it('takes the web page on the client origin and a named cross-origin caller', () => {
    process.env.MANTLE_CLIENT_ORIGIN = 'https://app.example.invalid/';
    process.env.MANTLE_API_CORS_ORIGINS = 'https://other.example.invalid, http://localhost:3001';
    expect(handoffTarget(s, 'https://app.example.invalid/auth/oidc')).toBeTruthy();
    expect(handoffTarget(s, 'https://other.example.invalid/auth/oidc')).toBeTruthy();
    expect(handoffTarget(s, 'http://localhost:3001/auth/oidc')).toBeTruthy();
  });

  it('never takes the wildcard for a target', () => {
    process.env.MANTLE_API_CORS_ORIGINS = '*';
    expect(handoffTarget(s, 'https://evil.example.invalid/auth/oidc')).toBeNull();
  });

  // A brain serves pages that run other people's script: any of these could
  // send a code on.
  it.each([
    `${BRAIN}/s/token/frame?t=x`,
    `${BRAIN}/api/presents/1/frame`,
    `${BRAIN}/login`,
    `${BRAIN}/`,
    `${BRAIN}/auth/oidc/`,
    `${BRAIN}/auth/oidc/x`,
    `${BRAIN}/auth/oidc?x=1`,
    `${BRAIN}/auth/oidc/../../s/token/frame`,
    `${BRAIN}/AUTH/OIDC`,
  ])('refuses a page of a trusted origin that is not the one target: %s', (raw) => {
    expect(handoffTarget(s, raw)).toBeNull();
  });

  it.each([
    'https://evil.example.invalid/auth/oidc',
    `${BRAIN}.evil.example.invalid/auth/oidc`,
    'mantle://oidc/other',
    'mantle://evil',
    'other://oidc',
    'javascript:alert(1)',
    `${BRAIN}/auth/oidc#x`,
    `https://user:pw@brain.example.invalid/auth/oidc`,
    'http://brain.example.invalid/auth/oidc',
    '',
    `${BRAIN}/${'a'.repeat(600)}`,
    42,
    null,
  ])('refuses %s', (raw) => {
    expect(handoffTarget(s, raw)).toBeNull();
  });

  it('needs a challenge of the S256 shape', () => {
    expect(readHandoff(s, APP_REDIRECT, CHALLENGE)).toEqual({
      redirect: APP_REDIRECT,
      challenge: CHALLENGE,
    });
    expect(readHandoff(s, APP_REDIRECT, 'short')).toBeNull();
    expect(readHandoff(s, APP_REDIRECT, `${CHALLENGE}!`)).toBeNull();
    expect(readHandoff(s, 'https://evil.example.invalid/', CHALLENGE)).toBeNull();
  });

  it('puts the code in the fragment, and names the brain that sent it', () => {
    const h = { redirect: `${BRAIN}/auth/oidc`, challenge: CHALLENGE };
    const iss = encodeURIComponent(BRAIN);
    expect(handoffCodeUrl(s, h, 'c', 'signin')).toBe(
      `${BRAIN}/auth/oidc#oidc=code&code=c&purpose=signin&iss=${iss}`,
    );
    expect(handoffFailedUrl(s, h, 'not-linked')).toBe(
      `${BRAIN}/auth/oidc#oidc=not-linked&iss=${iss}`,
    );
  });

  it('asks at an app and a named cross-origin caller, never silently', () => {
    process.env.MANTLE_CLIENT_ORIGIN = 'https://app.example.invalid';
    process.env.MANTLE_API_CORS_ORIGINS = 'http://localhost:3001';
    const ask = (redirect: string) => mustAsk(s, { redirect, challenge: CHALLENGE });
    expect(ask(APP_REDIRECT)).toBe(true);
    expect(ask('http://localhost:3001/auth/oidc')).toBe(true);
    expect(ask(`${BRAIN}/auth/oidc`)).toBe(false);
    expect(ask('https://app.example.invalid/auth/oidc')).toBe(false);
  });
});

describe('the code and the verifier', () => {
  it('keeps only a hash, and each code is new', () => {
    const a = newHandoffCode();
    const b = newHandoffCode();
    expect(a.code).not.toBe(b.code);
    expect(a.hash).toBe(handoffCodeHash(a.code));
    expect(a.hash).not.toContain(a.code);
    expect(Buffer.from(a.code, 'base64url')).toHaveLength(32);
  });

  it('takes only the verifier the challenge was made from', () => {
    expect(verifierMatches(VERIFIER, CHALLENGE)).toBe(true);
    expect(verifierMatches('b'.repeat(43), CHALLENGE)).toBe(false);
    expect(verifierMatches('short', CHALLENGE)).toBe(false);
    expect(verifierMatches(`${VERIFIER}\n`, CHALLENGE)).toBe(false);
    expect(verifierMatches('a'.repeat(129), CHALLENGE)).toBe(false);
  });
});

describe('the consent binding', () => {
  const q = {
    clientId: 'c',
    redirectUri: 'https://x.invalid/cb',
    codeChallenge: 'ch',
    scope: 'mcp',
    foreignResource: '',
  };

  it('names one request', () => {
    expect(consentBinding(q)).toBe(consentBinding({ ...q }));
    expect(consentBinding({ ...q, clientId: 'd' })).not.toBe(consentBinding(q));
    expect(consentBinding({ ...q, redirectUri: 'https://y.invalid/' })).not.toBe(consentBinding(q));
    expect(consentBinding({ ...q, codeChallenge: 'other' })).not.toBe(consentBinding(q));
    expect(consentBinding({ ...q, scope: 'mcp more' })).not.toBe(consentBinding(q));
    expect(consentBinding({ ...q, foreignResource: 'https://y.invalid/' })).not.toBe(
      consentBinding(q),
    );
  });

  it('can never pass as a client challenge', () => {
    expect(verifierMatches(VERIFIER, consentBinding(q))).toBe(false);
  });
});

describe('off', () => {
  beforeEach(() => {
    process.env.MANTLE_OIDC_MODE = 'off';
  });
  afterEach(() => {
    delete process.env.MANTLE_OIDC_MODE;
  });

  it('a step-up reads nothing, and a fresh proof buys nothing', async () => {
    const { spendConsentFresh, spendFresh, stepUpFor } = await import('./fresh');
    const login = { loginId: 'l1', sessionEpoch: 0 };
    expect(await stepUpFor('l1')).toEqual({ kind: 'password' });
    expect(await spendFresh(login, { code: 'c', verifier: VERIFIER })).toBe(false);
    expect(await spendConsentFresh(login, 'c', 'b')).toBe(false);
  });
});

describe('re-minting a cookie beside a bearer', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'oidc-handoff-test-secret-at-least-32-chars';
  });
  const withBearer = (token: string) =>
    new Request(`${BRAIN}/x`, { headers: { authorization: `Bearer ${token}` } });

  it('a live company bearer gives the cookie its end and its mark', () => {
    const { value } = buildMobileToken('u1', 'j1', 3600, 2, { oidc: true });
    const opts = ownCookieOpts(withBearer(value), 'j1');
    expect(opts).toMatchObject({ oidc: true, deviceJti: 'j1' });
    expect(opts.ttlSeconds).toBeLessThanOrEqual(3600);
  });

  it('a revoked or foreign company bearer puts no mark on a password cookie', () => {
    const { value } = buildMobileToken('u1', 'j1', 3600, 2, { oidc: true });
    const opts = ownCookieOpts(withBearer(value), null);
    expect(opts.oidc).toBeUndefined();
    expect(opts.deviceJti).toBeUndefined();
  });
});

describe('the start ticket', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'oidc-handoff-test-secret-at-least-32-chars';
  });
  const handoff = { redirect: APP_REDIRECT, challenge: CHALLENGE };

  it('carries a link, always to a client', () => {
    const t = { purpose: 'link', loginId: 'l1', epoch: 3, held: true, handoff } as const;
    expect(readStartTicket(signStartTicket(t))).toEqual(t);
    // A link with no client to finish it is no ticket.
    const { value } = signClaims({ k: 's', p: 'link', uid: 'l1', ep: 3, h: 1 }, 60);
    expect(readStartTicket(value)).toBeNull();
  });

  it('carries a fresh sign-in to a client or the consent page, never to nowhere', () => {
    const t = { purpose: 'fresh', loginId: 'l1', epoch: 3, handoff } as const;
    expect(readStartTicket(signStartTicket(t))).toEqual(t);
    const c = { purpose: 'fresh', loginId: 'l1', epoch: 3, consent: 'client_id=x' } as const;
    expect(readStartTicket(signStartTicket(c))).toEqual(c);
    const { value } = signClaims({ k: 's', p: 'fresh', uid: 'l1', ep: 3 }, 60);
    expect(readStartTicket(value)).toBeNull();
  });

  it('refuses a forged, another kind of, or lapsed ticket', () => {
    const t = { purpose: 'link', loginId: 'l1', epoch: 3, held: false, handoff } as const;
    expect(readStartTicket(`${signStartTicket(t)}x`)).toBeNull();
    expect(readStartTicket(signClaims({ k: 'h', uid: 'l1', ep: 3, h: 0 }, 60).value)).toBeNull();
    expect(
      readStartTicket(signClaims({ k: 's', p: 'link', uid: 'l1', ep: 3, h: 0 }, -1).value),
    ).toBeNull();
  });
});

describe('a bearer company sign-in made', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = 'oidc-handoff-test-secret-at-least-32-chars';
  });

  it('carries its mark, and is judged as a company session', () => {
    const { value } = buildMobileToken('u1', 'j1', 3600, 2, { oidc: true });
    const claims = verifyMobileToken(value)!;
    expect(claims).toMatchObject({ uid: 'u1', jti: 'j1', ep: 2, oidc: true });
    const kind = bearerSessionKind(claims);
    expect(kind.kind).toBe('sso');
    expect(kind.kind === 'sso' && kind.secondsLeft).toBeLessThanOrEqual(3600);
  });

  it('a password bearer stays a password session', () => {
    const { value } = buildMobileToken('u1', 'j1', 3600);
    const claims = verifyMobileToken(value)!;
    expect(claims.oidc).toBeUndefined();
    expect(bearerSessionKind(claims)).toBe(DEVICE_BEARER);
  });

  it('refuses a mark with no epoch: a racing unlink could not end it', () => {
    const { value } = signClaims({ uid: 'u1', jti: 'j1', k: 'm', so: 1 }, 60);
    expect(verifyMobileToken(value)).toBeNull();
  });

  it('refuses a mark of any other shape', () => {
    const { value } = signClaims({ uid: 'u1', jti: 'j1', k: 'm', ep: 1, so: 2 }, 60);
    expect(verifyMobileToken(value)).toBeNull();
  });
});
