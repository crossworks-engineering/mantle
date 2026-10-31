/**
 * Company sign-in's pure parts: the mode words, the settings, the two
 * cookies (their kinds, their checks, the return path) and the session
 * cookie that will not take either kind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from '@/server/http-compat';
import { parseOidcMode } from '@mantle/config';
import { signClaims } from '@mantle/crypto';
import { buildSessionCookie, verifySessionCookie } from '@/lib/auth/tokens';
import { ownCookieOpts, ownOidcCookieEnd } from '@/lib/auth/own-device';
import { assertEnvShape } from '@mantle/config';
import {
  OIDC_FLOW_COOKIE,
  OIDC_TICKET_COOKIE,
  readFlowCookie,
  readTicketCookie,
  safeReturnPath,
  setFlowCookie,
  setTicketCookie,
} from './cookies';
import { isLoopbackHost, issuerKey } from './provider';
import { DEFAULT_OIDC_LABEL, oidcLabel, oidcSettings } from './settings';

/** The names on https (the brain's own origin): `__Host-` prefixed. */
/** A link flow's start: now (its provider sign-in is checked against it). */
const NOW = Math.floor(Date.now() / 1000);
const FLOW = `__Host-${OIDC_FLOW_COOKIE}`;
const TICKET = `__Host-${OIDC_TICKET_COOKIE}`;
const BRAIN = 'https://brain.example.invalid';

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'x'.repeat(48));
});
afterEach(() => vi.unstubAllEnvs());

describe('MANTLE_OIDC_MODE words', () => {
  it.each([
    [undefined, 'off'],
    ['', 'off'],
    ['  ', 'off'],
    ['off', 'off'],
    ['0', 'off'],
    ['false', 'off'],
    ['optional', 'optional'],
    ['OPTIONAL', 'optional'],
    ['required', 'required'],
    // An operator who turns it on and says no more gets optional, never
    // required (plan section 17.4).
    ['on', 'optional'],
    ['true', 'optional'],
    ['1', 'optional'],
    ['yes', 'optional'],
    ['requird', null],
    ['strict', null],
  ])('%j is %j', (raw, want) => {
    expect(parseOidcMode(raw)).toBe(want);
  });
});

describe('the settings', () => {
  const on = () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://idp.example.invalid/realms/company');
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
    vi.stubEnv('MANTLE_PUBLIC_URL', BRAIN);
  };

  it('a complete optional box is on, with a 12-hour session and the callback on the public URL', () => {
    on();
    const s = oidcSettings();
    expect(s).toMatchObject({
      mode: 'optional',
      clientSecret: null,
      label: DEFAULT_OIDC_LABEL,
      sessionSeconds: 12 * 3600,
      redirectUri: `${BRAIN}/api/auth/oidc/callback`,
    });
  });

  it.each(['MANTLE_OIDC_ISSUER', 'MANTLE_OIDC_CLIENT_ID', 'MANTLE_PUBLIC_URL'] as const)(
    'with %s missing it is off: passwords stay',
    (name) => {
      on();
      vi.stubEnv(name, '');
      expect(oidcSettings()).toEqual({ mode: 'off' });
    },
  );

  it('session hours are held to 1 to 168; garbage is the default', () => {
    on();
    vi.stubEnv('MANTLE_OIDC_SESSION_HOURS', '1000');
    expect((oidcSettings() as { sessionSeconds: number }).sessionSeconds).toBe(168 * 3600);
    vi.stubEnv('MANTLE_OIDC_SESSION_HOURS', '0');
    expect((oidcSettings() as { sessionSeconds: number }).sessionSeconds).toBe(12 * 3600);
    vi.stubEnv('MANTLE_OIDC_SESSION_HOURS', 'many');
    expect((oidcSettings() as { sessionSeconds: number }).sessionSeconds).toBe(12 * 3600);
    vi.stubEnv('MANTLE_OIDC_SESSION_HOURS', '8');
    expect((oidcSettings() as { sessionSeconds: number }).sessionSeconds).toBe(8 * 3600);
  });

  it('the label is one line of at most 60 characters', () => {
    expect(oidcLabel('  Acme\nSign-in ')).toBe('Acme Sign-in');
    expect(oidcLabel('x'.repeat(100))).toHaveLength(60);
    expect(oidcLabel('')).toBe(DEFAULT_OIDC_LABEL);
  });

  it('an issuer key drops one trailing slash; loopback is only loopback', () => {
    expect(issuerKey('https://idp.example.invalid/')).toBe('https://idp.example.invalid');
    expect(issuerKey('https://idp.example.invalid/r/x')).toBe('https://idp.example.invalid/r/x');
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.example.invalid')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });
});

describe('the return path', () => {
  it.each([
    ['/', '/'],
    ['/settings/profile', '/settings/profile'],
    ['/a?b=1#c', '/a?b=1#c'],
    ['//evil.example.invalid', '/'],
    ['/\\evil.example.invalid', '/'],
    ['https://evil.example.invalid', '/'],
    ['javascript:alert(1)', '/'],
    ['/a\r\nSet-Cookie: x=1', '/'],
    ['', '/'],
    [null, '/'],
    ['/' + 'a'.repeat(600), '/'],
    ['/..//evil.example.invalid', '/'],
    ['/a/../..//evil.example.invalid/x', '/'],
    ['/api/auth/oidc/start', '/'],
    ['/api', '/'],
    ['/apiary', '/apiary'],
  ])('%j is %j', (raw, want) => {
    expect(safeReturnPath(raw)).toBe(want);
  });
});

/** The cookie a response set, as the browser would send it back. */
function sent(res: NextResponse, name: string): string {
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
  if (!c) throw new Error(`no ${name}`);
  return c.split(';')[0]!;
}
const reqWith = (cookie: string) =>
  new Request(`${BRAIN}/api/auth/oidc/callback`, { headers: { cookie } });

describe('the flow and ticket cookies', () => {
  const secrets = { state: 'st-1', nonce: 'n-1', codeVerifier: 'cv-1' };

  it('a link flow comes back as it went, on the oidc path, httpOnly, Lax, 10 minutes', () => {
    const res = NextResponse.json({});
    setFlowCookie(res, new Request(BRAIN), {
      purpose: 'link',
      returnTo: '/settings',
      ...secrets,
      loginId: 'L1',
      epoch: 4,
      held: true,
      startedAt: NOW,
    });
    const raw = res.headers.getSetCookie()[0]!;
    expect(raw).toMatch(/^__Host-mantle_oidc_flow=/);
    expect(raw).toMatch(/Path=\/(;|$)/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Max-Age=600/);
    expect(raw).toMatch(/Secure/);
    expect(readFlowCookie(reqWith(sent(res, FLOW)))).toEqual({
      purpose: 'link',
      returnTo: '/settings',
      ...secrets,
      loginId: 'L1',
      epoch: 4,
      held: true,
      startedAt: NOW,
    });
  });

  it('a ticket is Strict, 5 minutes (held too), and comes back as it went', () => {
    const held = NextResponse.json({});
    setTicketCookie(held, new Request(BRAIN), { loginId: 'L1', epoch: 2, held: true });
    expect(held.headers.getSetCookie()[0]).toMatch(/Max-Age=300/);
    const res = NextResponse.json({});
    setTicketCookie(res, new Request(BRAIN), { loginId: 'L1', epoch: 2, held: false });
    const raw = res.headers.getSetCookie()[0]!;
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Max-Age=300/);
    expect(readTicketCookie(reqWith(sent(res, TICKET)))).toEqual({
      loginId: 'L1',
      epoch: 2,
      held: false,
    });
  });

  it('kinds never cross: a ticket is no flow, a flow no ticket, neither a session', () => {
    const flow = signClaims({ k: 'o', p: 'signin', st: 's', n: 'n', cv: 'c', r: '/' }, 60).value;
    const ticket = signClaims({ k: 'h', uid: 'L1', ep: 0, h: 1 }, 60).value;
    expect(readTicketCookie(reqWith(`${TICKET}=${flow}`))).toBeNull();
    expect(readFlowCookie(reqWith(`${FLOW}=${ticket}`))).toBeNull();
    expect(verifySessionCookie(flow)).toBeNull();
    expect(verifySessionCookie(ticket)).toBeNull();
    // A session cookie is no ticket either.
    const session = signClaims({ uid: 'L1', ep: 0 }, 60).value;
    expect(readTicketCookie(reqWith(`${TICKET}=${session}`))).toBeNull();
  });

  it('a forged, expired or malformed value reads as none', () => {
    const good = signClaims({ k: 'h', uid: 'L1', ep: 0, h: 0 }, 60).value;
    const forged = `${good.slice(0, -2)}xx`;
    const expired = signClaims({ k: 'h', uid: 'L1', ep: 0, h: 0 }, -1).value;
    const badEpoch = signClaims({ k: 'h', uid: 'L1', ep: -1, h: 0 }, 60).value;
    const badHeld = signClaims({ k: 'h', uid: 'L1', ep: 0, h: 'yes' }, 60).value;
    for (const v of [forged, expired, badEpoch, badHeld, 'garbage']) {
      expect(readTicketCookie(reqWith(`${TICKET}=${v}`))).toBeNull();
    }
    const noVerifier = signClaims({ k: 'o', p: 'signin', st: 's', n: 'n', r: '/' }, 60).value;
    const badPurpose = signClaims({ k: 'o', p: 'admin', st: 's', n: 'n', cv: 'c' }, 60).value;
    for (const v of [noVerifier, badPurpose]) {
      expect(readFlowCookie(reqWith(`${FLOW}=${v}`))).toBeNull();
    }
  });

  it("a flow's return path is held safe even when signed", () => {
    const v = signClaims(
      { k: 'o', p: 'signin', st: 's', n: 'n', cv: 'c', r: '//evil.example.invalid' },
      60,
    ).value;
    expect(readFlowCookie(reqWith(`${FLOW}=${v}`))?.returnTo).toBe('/');
  });
});

describe('a company sign-in session keeps its short life', () => {
  const withCookie = (value: string, bearer = false) =>
    new Request(BRAIN, {
      headers: {
        cookie: `mantle_session=${value}`,
        ...(bearer ? { authorization: 'Bearer x' } : {}),
      },
    });

  it('the cookie carries the mark, and a forged mark value is no session', () => {
    const sso = buildSessionCookie('L1', { epoch: 2, ttlSeconds: 3600, oidc: true }).value;
    expect(verifySessionCookie(sso)).toMatchObject({ uid: 'L1', ep: 2, oidc: true });
    const plain = buildSessionCookie('L1', { epoch: 2 }).value;
    expect(verifySessionCookie(plain)?.oidc).toBeUndefined();
    const bad = signClaims({ uid: 'L1', ep: 0, so: 2 }, 60).value;
    expect(verifySessionCookie(bad)).toBeNull();
  });

  it('a re-mint (password change) keeps the end it had, never a year', () => {
    const sso = buildSessionCookie('L1', { epoch: 2, ttlSeconds: 3600, oidc: true }).value;
    const opts = ownCookieOpts(withCookie(sso), null);
    expect(opts.oidc).toBe(true);
    expect(opts.ttlSeconds).toBeGreaterThan(3590);
    expect(opts.ttlSeconds).toBeLessThanOrEqual(3600);
    expect(ownOidcCookieEnd(withCookie(sso))).toBe(opts.ttlSeconds);
    // A junk (or revoked) bearer header beside it changes nothing: the
    // session resolves on the cookie, whose end is kept.
    const withJunk = ownCookieOpts(withCookie(sso, true), null);
    expect(withJunk).toMatchObject({ oidc: true });
    expect(withJunk.ttlSeconds).toBeLessThanOrEqual(3600);
    // A quoted cookie is the same cookie to the session's parser, and here.
    const quoted = new Request(BRAIN, { headers: { cookie: `mantle_session="${sso}"` } });
    expect(ownOidcCookieEnd(quoted)).not.toBeNull();
    expect(ownCookieOpts(quoted, null)).toMatchObject({ oidc: true });
    // A password session keeps its year, as before.
    const plain = buildSessionCookie('L1', { epoch: 2 }).value;
    expect(ownCookieOpts(withCookie(plain), null)).toEqual({});
    expect(ownOidcCookieEnd(withCookie(plain))).toBeNull();
  });
});

describe('the boot check of the settings', () => {
  const clear = () => {
    for (const n of [
      'MANTLE_OIDC_MODE',
      'MANTLE_OIDC_ISSUER',
      'MANTLE_OIDC_CLIENT_ID',
      'MANTLE_PUBLIC_URL',
      'DATABASE_URL',
      'ALLOWED_USER_ID',
    ]) {
      vi.stubEnv(n, '');
    }
  };

  it('off asks nothing of the other settings (a stray issuer is fine)', () => {
    clear();
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'not a url');
    expect(() => assertEnvShape()).not.toThrow();
  });

  it('an unknown mode word stops the boot', () => {
    clear();
    vi.stubEnv('MANTLE_OIDC_MODE', 'requird');
    expect(() => assertEnvShape()).toThrow(/MANTLE_OIDC_MODE/);
  });

  it('required with a setting missing stops the boot; optional falls back to passwords', () => {
    clear();
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://idp.example.invalid/r');
    expect(() => assertEnvShape()).toThrow(/MANTLE_OIDC_CLIENT_ID must be set/);
    vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
    expect(() => assertEnvShape()).not.toThrow();
  });

  it('required with an issuer or public URL the sign-in cannot use stops the boot', () => {
    clear();
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
    vi.stubEnv('MANTLE_PUBLIC_URL', 'https://brain.example.invalid');
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://');
    expect(() => assertEnvShape()).toThrow(/MANTLE_OIDC_ISSUER must be a URL/);
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'http://idp.example.invalid/r');
    expect(() => assertEnvShape()).toThrow(/must use https/);
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'http://127.0.0.1:8180/realms/t');
    expect(() => assertEnvShape()).not.toThrow();
    vi.stubEnv('MANTLE_PUBLIC_URL', 'https://bad host');
    expect(() => assertEnvShape()).toThrow(/MANTLE_PUBLIC_URL must be a URL/);
  });
});

describe('the one session gate (hold.ts sessionMayAct): mode x link x kind x life', () => {
  const HOURS = 12 * 3600;
  const on = (mode: 'optional' | 'required', outsideAllowed = false) =>
    ({
      mode,
      issuer: 'https://idp.example.invalid',
      clientId: 'c',
      clientSecret: null,
      label: 'SSO',
      sessionSeconds: HOURS,
      redirectUri: `${BRAIN}/api/auth/oidc/callback`,
      outsideAllowed,
    }) as const;
  const S = {
    off: { mode: 'off' } as const,
    optional: on('optional'),
    required: on('required'),
    requiredOutside: on('required', true),
  };
  const f = (
    p: Partial<{ owner: boolean; linked: boolean; outside: boolean; admin: boolean }>,
  ) => ({
    owner: false,
    linked: false,
    outside: false,
    admin: false,
    ...p,
  });
  const F = {
    gone: null,
    unlinked: f({}),
    linked: f({ linked: true }),
    owner: f({ owner: true }),
    ownerLinked: f({ owner: true, linked: true }),
    outside: f({ outside: true }),
    outsideAdmin: f({ outside: true, admin: true }),
  };
  const K = {
    password: { kind: 'password' } as const,
    sso: { kind: 'sso', secondsLeft: HOURS - 60 } as const,
    ssoTooLong: { kind: 'sso', secondsLeft: HOURS + 60 } as const,
    ssoSpent: { kind: 'sso', secondsLeft: 0 } as const,
  };
  // [settings, facts, kind, acts]
  const rows: [keyof typeof S, keyof typeof F, keyof typeof K, boolean][] = [
    // Off: passwords as on main; no company sign-in session at all.
    ['off', 'gone', 'password', true],
    ['off', 'unlinked', 'password', true],
    ['off', 'linked', 'password', true],
    ['off', 'linked', 'sso', false],
    ['off', 'owner', 'sso', false],
    // Optional: every password session; an SSO one while linked and short.
    ['optional', 'unlinked', 'password', true],
    ['optional', 'linked', 'password', true],
    ['optional', 'gone', 'password', true],
    ['optional', 'linked', 'sso', true],
    ['optional', 'ownerLinked', 'sso', true],
    ['optional', 'unlinked', 'sso', false],
    ['optional', 'owner', 'sso', false],
    ['optional', 'gone', 'sso', false],
    ['optional', 'linked', 'ssoTooLong', false],
    ['optional', 'linked', 'ssoSpent', false],
    // Required: a password only for the original account and an honoured
    // outside person; SSO as in optional.
    ['required', 'owner', 'password', true],
    ['required', 'ownerLinked', 'password', true],
    ['required', 'unlinked', 'password', false],
    ['required', 'linked', 'password', false],
    ['required', 'gone', 'password', false],
    ['required', 'outside', 'password', false],
    ['requiredOutside', 'outside', 'password', true],
    ['requiredOutside', 'outsideAdmin', 'password', false],
    ['requiredOutside', 'linked', 'password', false],
    ['required', 'linked', 'sso', true],
    ['required', 'ownerLinked', 'sso', true],
    ['required', 'unlinked', 'sso', false],
    ['required', 'linked', 'ssoTooLong', false],
    ['required', 'linked', 'ssoSpent', false],
  ];
  it.each(rows)('%s, %s login, %s session: acts %s', async (s, facts, kind, acts) => {
    const { sessionMayAct } = await import('./hold');
    expect(sessionMayAct(S[s], K[kind], F[facts])).toBe(acts);
  });

  it('off, and a password session outside required mode, decide with no read', async () => {
    const store = await import('./store');
    const read = vi.spyOn(store, 'oidcRuleFacts');
    const { sessionHeld, DEVICE_BEARER, forgetHolds } = await import('./hold');
    forgetHolds();
    expect(sessionHeld('l1', DEVICE_BEARER)).toBe(false);
    expect(sessionHeld('l1', { kind: 'sso', secondsLeft: 60 })).toBe(true);
    vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://idp.example.invalid');
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'c');
    vi.stubEnv('MANTLE_PUBLIC_URL', BRAIN);
    expect(sessionHeld('l1', DEVICE_BEARER)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('a read that fails holds the session and is not kept', async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://idp.example.invalid');
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'c');
    vi.stubEnv('MANTLE_PUBLIC_URL', BRAIN);
    const store = await import('./store');
    const read = vi
      .spyOn(store, 'oidcRuleFacts')
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ owner: true, linked: false, outside: false, admin: false });
    const { sessionHeld, DEVICE_BEARER, forgetHolds } = await import('./hold');
    forgetHolds();
    expect(await sessionHeld('l2', DEVICE_BEARER)).toBe(true);
    expect(await sessionHeld('l2', DEVICE_BEARER)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockRestore();
  });
});
