/**
 * Company sign-in on (docs/oidc-sign-in.md), with the provider and the
 * rows stood in: the required-mode password rule, the sign-in callback,
 * the link (in a session, and held), the offer and the unlink. The real
 * provider round trip runs against a local OIDC provider
 * (server/web/scripts/oidc-flow-check.ts), the rows on Postgres
 * (store.db.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from '@/server/http-compat';
import { verifySessionCookie } from '@/lib/auth/tokens';
import { setFlowCookie, setTicketCookie, OIDC_FLOW_COOKIE, OIDC_TICKET_COOKIE } from './cookies';

/** The names on https (the brain's own origin): `__Host-` prefixed. */
/** A link flow's start: now (its provider sign-in is checked against it). */
const NOW = Math.floor(Date.now() / 1000);
const FLOW = `__Host-${OIDC_FLOW_COOKIE}`;
const TICKET = `__Host-${OIDC_TICKET_COOKIE}`;
const ISSUER = 'https://idp.example.invalid/realms/company';
const BRAIN = 'https://brain.example.invalid';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

type Row = { id: string; email: string; sessionEpoch: number; isOwner: boolean; usable: boolean };
const h = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  links: [] as { id: string; loginId: string; issuer: string; subject: string }[],
  outside: new Set<string>(),
  dismissed: new Map<string, Date>(),
  identity: null as null | { issuer: string; subject: string; tid: null; oid: null },
  session: null as null | { loginId: string; email: string; sessionEpoch: number; source: string },
  passwordOk: false,
  audits: [] as { action: string; detail?: Record<string, unknown> }[],
  admins: new Set<string>(),
  noPassword: new Set<string>(),
  applied: null as string | null,
  ended: [] as string[],
}));

vi.mock('./store', () => ({
  oidcLoginRow: async (id: string) => h.rows.get(id) ?? null,
  oidcRuleFacts: async (id: string, issuer: string) => {
    const r = h.rows.get(id);
    if (!r) return null;
    return {
      owner: r.isOwner,
      linked: h.links.some((l) => l.loginId === id && l.issuer === issuer),
      outside: h.outside.has(id),
      admin: h.admins.has(id),
    };
  },
  signInTarget: async (issuer: string, subject: string) => {
    const l = h.links.find((x) => x.issuer === issuer && x.subject === subject);
    const row = l ? h.rows.get(l.loginId) : undefined;
    return l && row ? { linkId: l.id, row } : null;
  },
  loginHasPassword: async (id: string) => !h.noPassword.has(id),
  linkForSubject: async (issuer: string, subject: string) =>
    h.links.find((l) => l.issuer === issuer && l.subject === subject) ?? null,
  loginLinked: async (loginId: string, issuer: string) =>
    h.links.some((l) => l.loginId === loginId && l.issuer === issuer),
  loginOidcState: async (loginId: string) => ({
    outside: h.outside.has(loginId),
    offerDismissedUntil: h.dismissed.get(loginId) ?? null,
  }),
  createLink: async (loginId: string, epoch: number, id: { issuer: string; subject: string }) => {
    if (h.rows.get(loginId)?.sessionEpoch !== epoch) return 'expired';
    const hit = h.links.find((l) => l.issuer === id.issuer && l.subject === id.subject);
    if (hit) return hit.loginId === loginId ? 'linked' : 'taken';
    if (h.links.some((l) => l.loginId === loginId && l.issuer === id.issuer)) return 'has-other';
    h.links.push({ id: `link-${h.links.length}`, loginId, ...id });
    return 'linked';
  },
  touchLink: async () => {},
  removeLink: async (loginId: string, issuer: string) => {
    const before = h.links.length;
    h.links = h.links.filter((l) => !(l.loginId === loginId && l.issuer === issuer));
    return h.links.length < before;
  },
  setOutside: async (id: string, o: boolean) => void (o ? h.outside.add(id) : h.outside.delete(id)),
  dismissOffer: async (id: string, until: Date) => void h.dismissed.set(id, until),
  activeLoginsWithLinks: async () => [],
  appliedMode: async () => h.applied,
  recordAppliedMode: async (m: string) => void (h.applied = m),
  loginIsAdminUser: async (id: string) => h.admins.has(id),
}));

vi.mock('./provider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authorizationUrl: async (_s: unknown, f: { state: string }) =>
    `${ISSUER}/protocol/openid-connect/auth?state=${f.state}`,
  identityFromCallback: async (_s: unknown, q: URLSearchParams, f: { state: string }) => {
    if (q.get('state') !== f.state) throw new Error('state mismatch');
    if (!h.identity) throw new Error('no token');
    return h.identity;
  },
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyPassword: async () => h.passwordOk,
  endLoginSessions: async (id: string) => {
    h.ended.push(id);
    return 1;
  },
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const chain = { set: () => chain, where: async () => [] };
  return { ...real, db: { update: () => chain } };
});

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: (e: { action: string; detail?: Record<string, unknown> }) =>
    void h.audits.push(e),
  requestMetaFrom: () => ({}),
}));
vi.mock('./notify', () => ({ notifyLinkMade: async () => {} }));
vi.mock('@/lib/pair-code', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issuePairCode: async () => ({ id: 'p1', code: 'c', expiresAt: new Date(Date.now() + 60_000) }),
}));

const readLogin = async () => h.session as never;

beforeEach(() => {
  h.rows = new Map([
    [A, { id: A, email: 'a@example.invalid', sessionEpoch: 1, isOwner: false, usable: true }],
    [B, { id: B, email: 'b@example.invalid', sessionEpoch: 0, isOwner: true, usable: true }],
  ]);
  h.links = [];
  h.outside = new Set();
  h.dismissed = new Map();
  h.identity = { issuer: ISSUER, subject: 'sub-a', tid: null, oid: null };
  h.session = null;
  h.passwordOk = false;
  h.audits = [];
  h.admins = new Set();
  h.noPassword = new Set();
  h.applied = null;
  h.ended = [];
  vi.stubEnv('SESSION_SECRET', 'x'.repeat(48));
  vi.stubEnv('MANTLE_PUBLIC_URL', BRAIN);
  vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
  vi.stubEnv('MANTLE_OIDC_ISSUER', ISSUER);
  vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
  vi.stubEnv('MANTLE_OIDC_LABEL', 'Company');
});
afterEach(() => vi.unstubAllEnvs());

function cookieOf(res: Response, name: string): string | null {
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0]!.slice(name.length + 1) : null;
}
function setCookieOf(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
}

/** A flow cookie as the start would have set it. */
function flowCookie(flow: Parameters<typeof setFlowCookie>[2]): string {
  const res = NextResponse.json({});
  setFlowCookie(res, new Request(BRAIN), flow);
  return `${FLOW}=${cookieOf(res, FLOW)}`;
}
function ticketCookie(t: { loginId: string; epoch: number; held: boolean }): string {
  const res = NextResponse.json({});
  setTicketCookie(res, new Request(BRAIN), t);
  return `${TICKET}=${cookieOf(res, TICKET)}`;
}
const secrets = { state: 'st-1', nonce: 'n-1', codeVerifier: 'cv-1' };

async function callback(cookie: string, query = 'code=c&state=st-1') {
  const { oidcCallback } = await import('./flow');
  return oidcCallback(
    new Request(`${BRAIN}/api/auth/oidc/callback?${query}`, { headers: { cookie } }),
    readLogin,
  );
}

describe('the password rule', () => {
  it('optional: every login keeps its password', async () => {
    const { passwordSignInRule } = await import('./rules');
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    expect(await passwordSignInRule(A)).toBe('allow');
  });

  it('required: linked uses company sign-in only, unlinked links first, owner and outside keep passwords', async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    const { passwordSignInRule } = await import('./rules');
    expect(await passwordSignInRule(A)).toBe('link-required');
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    expect(await passwordSignInRule(A)).toBe('sso-required');
    // A linked login uses company sign-in only, whatever its marks.
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'on');
    h.outside.add(A);
    expect(await passwordSignInRule(A)).toBe('sso-required');
    h.links = [];
    expect(await passwordSignInRule(A)).toBe('allow');
    // The operator has not allowed outside logins: the mark keeps nothing.
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'off');
    expect(await passwordSignInRule(A)).toBe('link-required');
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'on');
    // A mark does not carry over a promotion to the Admin workspace.
    h.admins.add(A);
    expect(await passwordSignInRule(A)).toBe('link-required');
    h.admins.clear();
    expect(await passwordSignInRule(B)).toBe('allow');
    // A link to another issuer is not this site's link.
    h.outside.clear();
    h.links = [{ id: 'l', loginId: A, issuer: 'https://other.example.invalid', subject: 'x' }];
    expect(await passwordSignInRule(A)).toBe('link-required');
  });

  it("required: the held refusal carries the ticket; a token login's carries none", async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    const { passwordRefusal } = await import('./rules');
    const at = { path: '/api/auth/login', email: 'a@example.invalid', loginId: A };
    const held = passwordRefusal(new Request(BRAIN), 'link-required', at, { epoch: 1 });
    expect(held.status).toBe(403);
    expect(await held.json()).toMatchObject({ code: 'sso-link-required' });
    expect(setCookieOf(held, TICKET)).toBeDefined();
    expect(setCookieOf(held, 'mantle_session')).toBeUndefined();
    const token = passwordRefusal(new Request(BRAIN), 'link-required', at);
    expect(token.headers.getSetCookie()).toEqual([]);
    const sso = passwordRefusal(new Request(BRAIN), 'sso-required', at, { epoch: 1 });
    expect(await sso.json()).toEqual({ error: 'Sign in with Company.', code: 'sso-required' });
    expect(sso.headers.getSetCookie()).toEqual([]);
  });
});

describe('sign-in', () => {
  it('start sends the browser to the provider with a flow cookie', async () => {
    const { oidcStartSignIn } = await import('./flow');
    const res = await oidcStartSignIn(new Request(`${BRAIN}/api/auth/oidc/start?return=/x`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/idp\.example\.invalid\//);
    expect(setCookieOf(res, FLOW)).toBeDefined();
  });

  it('a linked account signs its login in, with a 12-hour session', async () => {
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    const res = await callback(flowCookie({ purpose: 'signin', returnTo: '/x', ...secrets }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BRAIN}/x#`);
    const session = setCookieOf(res, 'mantle_session')!;
    expect(session).toMatch(/Max-Age=43200/);
    const value = cookieOf(res, 'mantle_session')!;
    expect(verifySessionCookie(value)).toMatchObject({ uid: A, ep: 1, oidc: true });
  });

  it('an account linked to nobody makes no login and signs nobody in', async () => {
    const res = await callback(flowCookie({ purpose: 'signin', returnTo: '/', ...secrets }));
    expect(res.headers.get('location')).toBe(`${BRAIN}/login?oidc=not-linked#`);
    expect(setCookieOf(res, 'mantle_session')).toBeUndefined();
    expect(h.links).toEqual([]);
    expect(h.audits).toContainEqual(
      expect.objectContaining({
        action: 'auth.login_failed',
        detail: expect.objectContaining({ reason: 'not-linked', subject: 'sub-a', issuer: ISSUER }),
      }),
    );
  });

  it('a disabled login is not signed in', async () => {
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    h.rows.set(A, { ...h.rows.get(A)!, usable: false });
    const res = await callback(flowCookie({ purpose: 'signin', returnTo: '/', ...secrets }));
    expect(res.headers.get('location')).toBe(`${BRAIN}/login?oidc=not-allowed#`);
    expect(setCookieOf(res, 'mantle_session')).toBeUndefined();
  });

  it('no flow cookie, a provider error, or a state that does not match: no session', async () => {
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    const flow = flowCookie({ purpose: 'signin', returnTo: '/', ...secrets });
    const none = await callback('');
    expect(none.headers.get('location')).toBe(`${BRAIN}/login?oidc=expired#`);
    const denied = await callback(flow, 'error=access_denied&state=st-1');
    expect(denied.headers.get('location')).toBe(`${BRAIN}/login?oidc=cancelled#`);
    const swapped = await callback(flow, 'code=c&state=other');
    expect(swapped.headers.get('location')).toBe(`${BRAIN}/login?oidc=failed#`);
    for (const r of [none, denied, swapped]) {
      expect(setCookieOf(r, 'mantle_session')).toBeUndefined();
    }
  });
});

describe('link', () => {
  const linkReq = (cookie: string, body: unknown = {}) =>
    new Request(`${BRAIN}/api/auth/oidc/link`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('a session with the fresh ticket of its password sign-in starts in one click', async () => {
    h.session = { loginId: A, email: 'a@example.invalid', sessionEpoch: 1, source: 'web' };
    const { oidcStartLink } = await import('./flow');
    const res = await oidcStartLink(
      linkReq(ticketCookie({ loginId: A, epoch: 1, held: false })),
      readLogin,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).url).toMatch(/^https:\/\/idp\.example\.invalid\//);
    expect(setCookieOf(res, FLOW)).toBeDefined();
    // The ticket is used up.
    expect(setCookieOf(res, TICKET)).toMatch(/Max-Age=0/);
  });

  it("the password at a link start has the login's own failure budget, and a wrong one is audited", async () => {
    h.session = { loginId: B, email: 'b@example.invalid', sessionEpoch: 0, source: 'web' };
    const { oidcStartLink } = await import('./flow');
    for (let i = 0; i < 5; i++) {
      expect((await oidcStartLink(linkReq('', { password: 'wrong' }), readLogin)).status).toBe(401);
    }
    h.passwordOk = true;
    expect((await oidcStartLink(linkReq('', { password: 'right' }), readLogin)).status).toBe(429);
    expect(
      h.audits.filter((a) => a.detail?.channel === 'oidc-link' && a.detail.reason === 'password'),
    ).toHaveLength(5);
  });

  it("with no fresh ticket it asks for the password, and refuses a wrong one; another login's ticket is not fresh", async () => {
    h.session = { loginId: A, email: 'a@example.invalid', sessionEpoch: 1, source: 'web' };
    const { oidcStartLink } = await import('./flow');
    const none = await oidcStartLink(linkReq(''), readLogin);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: 'password-needed' });
    const other = await oidcStartLink(
      linkReq(ticketCookie({ loginId: B, epoch: 1, held: false })),
      readLogin,
    );
    expect(other.status).toBe(401);
    const stale = await oidcStartLink(
      linkReq(ticketCookie({ loginId: A, epoch: 0, held: false })),
      readLogin,
    );
    expect(stale.status).toBe(401);
    const wrong = await oidcStartLink(linkReq('', { password: 'wrong' }), readLogin);
    expect(wrong.status).toBe(401);
    h.passwordOk = true;
    const right = await oidcStartLink(linkReq('', { password: 'right' }), readLogin);
    expect(right.status).toBe(200);
  });

  it('a bearer session links on the web; no session and no held ticket is a 401', async () => {
    const { oidcStartLink } = await import('./flow');
    h.session = { loginId: A, email: 'a@example.invalid', sessionEpoch: 1, source: 'mobile' };
    expect((await oidcStartLink(linkReq(''), readLogin)).status).toBe(400);
    h.session = null;
    const fresh = ticketCookie({ loginId: A, epoch: 1, held: false });
    expect((await oidcStartLink(linkReq(fresh), readLogin)).status).toBe(401);
  });

  it('a linked login cannot start another link', async () => {
    h.session = { loginId: A, email: 'a@example.invalid', sessionEpoch: 1, source: 'web' };
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    const { oidcStartLink } = await import('./flow');
    const res = await oidcStartLink(
      linkReq(ticketCookie({ loginId: A, epoch: 1, held: false })),
      readLogin,
    );
    expect(res.status).toBe(409);
  });

  it('the callback links in the session that started it, and makes no new session', async () => {
    h.session = { loginId: A, email: 'a@example.invalid', sessionEpoch: 1, source: 'web' };
    const flow = { purpose: 'link' as const, returnTo: '/settings', ...secrets };
    const res = await callback(
      flowCookie({ ...flow, loginId: A, epoch: 1, held: false, startedAt: NOW }),
    );
    expect(res.headers.get('location')).toBe(`${BRAIN}/settings?oidc=linked#`);
    expect(h.links).toMatchObject([{ loginId: A, issuer: ISSUER, subject: 'sub-a' }]);
    expect(setCookieOf(res, 'mantle_session')).toBeUndefined();
  });

  it('another session, a changed epoch or a disabled login ends the link', async () => {
    const flow = { purpose: 'link' as const, returnTo: '/s', ...secrets };
    h.session = { loginId: B, email: 'b@example.invalid', sessionEpoch: 0, source: 'web' };
    const swapped = await callback(
      flowCookie({ ...flow, loginId: A, epoch: 1, held: false, startedAt: NOW }),
    );
    expect(swapped.headers.get('location')).toBe(`${BRAIN}/s?oidc=expired#`);
    h.session = { loginId: A, email: 'a@example.invalid', sessionEpoch: 1, source: 'web' };
    const bumped = await callback(
      flowCookie({ ...flow, loginId: A, epoch: 0, held: false, startedAt: NOW }),
    );
    expect(bumped.headers.get('location')).toBe(`${BRAIN}/s?oidc=expired#`);
    h.rows.set(A, { ...h.rows.get(A)!, usable: false });
    const off = await callback(
      flowCookie({ ...flow, loginId: A, epoch: 1, held: false, startedAt: NOW }),
    );
    expect(off.headers.get('location')).toBe(`${BRAIN}/s?oidc=expired#`);
    expect(h.links).toEqual([]);
  });

  it("an account that is another login's is never moved", async () => {
    h.links.push({ id: 'l', loginId: B, issuer: ISSUER, subject: 'sub-a' });
    h.session = { loginId: A, email: 'a@example.invalid', sessionEpoch: 1, source: 'web' };
    const flow = { purpose: 'link' as const, returnTo: '/s', ...secrets };
    const res = await callback(
      flowCookie({ ...flow, loginId: A, epoch: 1, held: false, startedAt: NOW }),
    );
    expect(res.headers.get('location')).toBe(`${BRAIN}/s?oidc=taken#`);
    expect(h.links).toHaveLength(1);
    expect(h.links[0]!.loginId).toBe(B);
  });

  it('required: a held login (no session) links on its held ticket and is then signed in', async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    const { oidcStartLink } = await import('./flow');
    const start = await oidcStartLink(
      linkReq(ticketCookie({ loginId: A, epoch: 1, held: true })),
      readLogin,
    );
    expect(start.status).toBe(200);
    const flow = cookieOf(start, FLOW)!;
    const res = await callback(`${FLOW}=${flow}`, `code=c&state=${flowState(flow)}`);
    expect(res.headers.get('location')).toBe(`${BRAIN}/?oidc=linked#`);
    expect(verifySessionCookie(cookieOf(res, 'mantle_session')!)).toMatchObject({ uid: A, ep: 1 });
    expect(setCookieOf(res, 'mantle_session')).toMatch(/Max-Age=43200/);
    expect(h.links.map((l) => l.loginId)).toEqual([A]);
  });

  it('a held ticket whose login changed since starts nothing', async () => {
    const { oidcStartLink } = await import('./flow');
    const res = await oidcStartLink(
      linkReq(ticketCookie({ loginId: A, epoch: 0, held: true })),
      readLogin,
    );
    expect(res.status).toBe(401);
  });
});

describe('status, offer and unlink', () => {
  it('an unlinked login is offered the link until it dismisses it; required asks it to link', async () => {
    h.session = { loginId: A, email: 'a@example.invalid', sessionEpoch: 1, source: 'web' };
    const { oidcStatusAnswer, oidcDismissOffer } = await import('./flow');
    expect(await (await oidcStatusAnswer(readLogin)).json()).toMatchObject({
      mode: 'optional',
      label: 'Company',
      linked: false,
      offer: true,
      linkRequired: false,
    });
    const d = await oidcDismissOffer(new Request(BRAIN, { method: 'POST' }), readLogin);
    const until = new Date((await d.json()).until).getTime();
    expect(until - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(await (await oidcStatusAnswer(readLogin)).json()).toMatchObject({ offer: false });
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    expect(await (await oidcStatusAnswer(readLogin)).json()).toMatchObject({
      linkRequired: true,
    });
  });

  it('unlink: open in optional mode, refused in required mode but for the owner and outside', async () => {
    const { oidcUnlinkSelf } = await import('./flow');
    const del = () => oidcUnlinkSelf(new Request(BRAIN, { method: 'DELETE' }), readLogin);
    h.session = { loginId: A, email: 'a@example.invalid', sessionEpoch: 1, source: 'web' };
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    expect((await del()).status).toBe(403);
    expect(h.links).toHaveLength(1);
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'on');
    h.outside.add(A);
    expect(await (await del()).json()).toEqual({ ok: true, unlinked: true });
    expect(h.links).toEqual([]);
    // Required: the sessions the link made end with it.
    expect(h.ended).toEqual([A]);
    // A mark the operator does not allow lets no one unlink in required mode.
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'off');
    expect((await del()).status).toBe(403);
    h.outside.clear();
    h.links = [];
    vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    expect(await (await del()).json()).toEqual({ ok: true, unlinked: true });
  });
});

/** The state a signed flow cookie carries (what the provider sends back). */
function flowState(value: string): string {
  const payload = value.slice(0, value.lastIndexOf('.'));
  const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  return (JSON.parse(json) as { st: string }).st;
}

describe('pairing a phone', () => {
  const pair = async (cookie: string) => {
    const auth = await import('@/lib/auth');
    vi.spyOn(auth, 'publicLoginItself').mockResolvedValue({
      loginId: A,
      email: 'a@example.invalid',
      sessionEpoch: 1,
      source: 'web',
    } as never);
    const { POST } = await import('../../app/api/auth/pair/route');
    return POST(new Request(`${BRAIN}/api/auth/pair`, { method: 'POST', headers: { cookie } }));
  };

  it('a company sign-in session cannot pair a phone (its bearer would outlive it); a password session can', async () => {
    const { buildSessionCookie } = await import('@/lib/auth/tokens');
    const sso = buildSessionCookie(A, { epoch: 1, ttlSeconds: 3600, oidc: true }).value;
    const refused = await pair(`mantle_session=${sso}`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'sso-session' });
    const plain = buildSessionCookie(A, { epoch: 1 }).value;
    expect((await pair(`mantle_session=${plain}`)).status).toBe(200);
  });
});

describe('the callback and the users area (audit round 2)', () => {
  it("a callback whose state is not this browser's flow ends nothing and names no login", async () => {
    const flow = flowCookie({
      purpose: 'link',
      returnTo: '/s',
      ...secrets,
      loginId: A,
      epoch: 1,
      held: false,
      startedAt: NOW,
    });
    const res = await callback(flow, 'error=access_denied&state=forged');
    expect(res.headers.get('location')).toBe(`${BRAIN}/login?oidc=failed#`);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('the outside mark is for outside people only: never self, an Admin user, the owner or a linked login', async () => {
    const { oidcAdminSetOutside } = await import('./flow');
    const mark = (target: string, actor = 'admin-x') =>
      oidcAdminSetOutside(
        new Request(BRAIN, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ outside: true }),
        }),
        target,
        { id: actor, email: 'x@example.invalid' },
      );
    // Refused while the operator has turned outside logins off.
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'off');
    expect((await mark(A)).status).toBe(409);
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'on');
    expect((await mark(A, A)).status).toBe(409);
    expect((await mark(B)).status).toBe(409); // the owner
    h.admins.add(A);
    expect((await mark(A)).status).toBe(409);
    h.admins.clear();
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    expect((await mark(A)).status).toBe(409);
    h.links = [];
    expect((await mark(A)).status).toBe(200);
    expect(h.outside.has(A)).toBe(true);
  });

  it("an admin's unlink ends the login's sessions too", async () => {
    const { oidcAdminUnlink } = await import('./flow');
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    const res = await oidcAdminUnlink(new Request(BRAIN, { method: 'DELETE' }), A, {
      id: 'admin-x',
      email: 'x@example.invalid',
    });
    expect(await res.json()).toEqual({ ok: true, unlinked: true });
    expect(h.ended).toEqual([A]);
  });

  it("an admin's unlink never leaves a login with no way in (no password: 409)", async () => {
    const { oidcAdminUnlink } = await import('./flow');
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    h.noPassword.add(A);
    const res = await oidcAdminUnlink(new Request(BRAIN, { method: 'DELETE' }), A, {
      id: 'admin-x',
      email: 'x@example.invalid',
    });
    expect(res.status).toBe(409);
    expect(h.links).toHaveLength(1);
    expect(h.ended).toEqual([]);
  });
});

describe('the hold of password sessions in required mode', () => {
  it('holds a password session of a login that must use company sign-in or link; never off, optional, the owner or an outside member', async () => {
    const { sessionHeld, DEVICE_BEARER, forgetHolds } = await import('./hold');
    const passwordSessionHeld = (id: string) => sessionHeld(id, DEVICE_BEARER);
    forgetHolds();
    expect(passwordSessionHeld(A)).toBe(false);
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    forgetHolds();
    expect(await passwordSessionHeld(A)).toBe(true); // unlinked: link first
    expect(await passwordSessionHeld(B)).toBe(false); // the owner
    forgetHolds();
    h.outside.add(A);
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'off');
    expect(await passwordSessionHeld(A)).toBe(true); // turned off by the operator
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'on');
    forgetHolds();
    expect(await passwordSessionHeld(A)).toBe(false);
    forgetHolds();
    h.links.push({ id: 'l', loginId: A, issuer: ISSUER, subject: 'sub-a' });
    expect(await passwordSessionHeld(A)).toBe(true); // linked: company sign-in only
  });
});

describe('the boot in required mode', () => {
  it('ends the sessions of every login the rule refuses; never the owner or an honoured outside person', async () => {
    const store = await import('./store');
    const auth = await import('@/lib/auth');
    const ended: unknown[][] = [];
    vi.spyOn(auth, 'endLoginSessions').mockImplementation(async (...a: unknown[]) => {
      ended.push(a);
      return 1;
    });
    const row = (
      id: string,
      x: Partial<{ owner: boolean; linked: boolean; outside: boolean; admin: boolean }>,
    ) => ({
      loginId: id,
      email: `${id}@example.invalid`,
      displayName: null,
      owner: false,
      admin: false,
      outside: false,
      linked: false,
      linkedAt: null,
      lastUsedAt: null,
      ...x,
    });
    (store as unknown as { activeLoginsWithLinks: unknown }).activeLoginsWithLinks = async () => [
      row('owner', { owner: true }),
      row('linked', { linked: true }),
      row('unlinked', {}),
      row('outside', { outside: true }),
      row('outside-admin', { outside: true, admin: true }),
    ];
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    vi.stubEnv('MANTLE_OIDC_OUTSIDE', 'on');
    const { oidcBootCheck } = await import('./boot');
    await oidcBootCheck();
    expect(ended.map((a) => a[0]).sort()).toEqual(['linked', 'outside-admin', 'unlinked']);
    // Links stay: endLoginSessions never removes one.
    expect(h.applied).toBe('required');
    // A plain restart in required mode ends nothing.
    ended.length = 0;
    await oidcBootCheck();
    expect(ended).toEqual([]);
    // Optional is recorded; the next switch into required ends them again.
    vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
    await oidcBootCheck();
    expect(ended).toEqual([]);
    expect(h.applied).toBe('optional');
    vi.stubEnv('MANTLE_OIDC_MODE', 'required');
    await oidcBootCheck();
    expect(ended.map((a) => a[0]).sort()).toEqual(['linked', 'outside-admin', 'unlinked']);
  });
});
