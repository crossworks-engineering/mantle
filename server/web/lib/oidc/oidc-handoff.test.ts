/**
 * Handing a company sign-in to a client (handoff.ts), with no database: where
 * a flow may end, the PKCE check, the start ticket, and the company mark on a
 * device bearer. Through the app on Postgres: oidc-handoff.db.test.ts.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signClaims } from '@mantle/crypto';
import { buildMobileToken, verifyMobileToken } from '@/lib/auth/tokens';
import {
  APP_REDIRECT,
  handoffCodeUrl,
  handoffFailedUrl,
  handoffTarget,
  newHandoffCode,
  handoffCodeHash,
  readHandoff,
  readStartTicket,
  signStartTicket,
  verifierMatches,
} from './handoff';
import { bearerSessionKind, DEVICE_BEARER } from './hold';
import type { OidcOn } from './settings';

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

  it('takes the app target and a page of the brain itself', () => {
    expect(handoffTarget(s, APP_REDIRECT)).toBe('mantle://oidc');
    expect(handoffTarget(s, `${BRAIN}/login`)).toBe(`${BRAIN}/login`);
  });

  it('takes the client origin and a named cross-origin caller', () => {
    process.env.MANTLE_CLIENT_ORIGIN = 'https://app.example.invalid/';
    process.env.MANTLE_API_CORS_ORIGINS = 'https://other.example.invalid, http://localhost:3001';
    expect(handoffTarget(s, 'https://app.example.invalid/login')).toBeTruthy();
    expect(handoffTarget(s, 'https://other.example.invalid/login')).toBeTruthy();
    expect(handoffTarget(s, 'http://localhost:3001/login')).toBeTruthy();
  });

  it('never takes the wildcard for a target', () => {
    process.env.MANTLE_API_CORS_ORIGINS = '*';
    expect(handoffTarget(s, 'https://evil.example.invalid/login')).toBeNull();
  });

  it.each([
    'https://evil.example.invalid/login',
    `${BRAIN}.evil.example.invalid/login`,
    'mantle://oidc/other',
    'mantle://evil',
    'other://oidc',
    'javascript:alert(1)',
    `${BRAIN}/login#x`,
    `https://user:pw@brain.example.invalid/login`,
    'http://brain.example.invalid/login',
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

  it('puts the code in the fragment, never the query', () => {
    const h = { redirect: `${BRAIN}/login`, challenge: CHALLENGE };
    expect(handoffCodeUrl(h, 'c', 'signin')).toBe(`${BRAIN}/login#oidc=code&code=c&purpose=signin`);
    expect(handoffFailedUrl(h, 'not-linked')).toBe(`${BRAIN}/login#oidc=not-linked`);
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
