/**
 * The two short cookies of company sign-in (docs/oidc-sign-in.md), both
 * signed values (@mantle/crypto signClaims) of their own kind, httpOnly,
 * `__Host-` prefixed on https (Path=/, no Domain: no sibling host can plant
 * one). Neither is a session: no route but the company sign-in routes reads
 * them.
 *
 *  - the FLOW cookie (kind 'o', 10 minutes): one sign-in or link flow from
 *    its start to its callback: the state, the nonce and the PKCE verifier,
 *    what the flow is for, and for a link the login and its session epoch.
 *    SameSite=Lax: the callback is a top-level navigation back from the
 *    provider, and Lax is what a browser sends there. A flow handed to a
 *    client (handoff.ts) also carries where it ends and the client's
 *    challenge.
 *  - the TICKET cookie (kind 'h', 5 minutes): proof that this
 *    browser signed in with the login's password just now, used up when a
 *    link starts on it. A link may start on it
 *    with no password typed again (the offer after a password sign-in), and
 *    in required mode it is the only thing an unlinked login holds (no
 *    session) until it links (`held`). SameSite=Strict: only the client's own
 *    request to start a link sends it.
 */
import type { NextResponse } from '@/server/http-compat';
import { signClaims, verifySigned } from '@mantle/crypto';
import { secureCookies } from '@/lib/auth-constants';
import { cookieValues } from '@/lib/auth/request';
import type { FlowSecrets } from './provider';

/** Path=/ so the cookies can carry the `__Host-` prefix on https: a
 *  sibling subdomain (or a man in the middle of plain http) cannot plant a
 *  `__Host-` cookie, so a flow or ticket of someone else's never reaches
 *  this brain's callback or link start. */
export const OIDC_COOKIE_PATH = '/';
export const OIDC_FLOW_COOKIE = 'mantle_oidc_flow';
export const OIDC_TICKET_COOKIE = 'mantle_oidc_ticket';

/** The cookie's name on this request: `__Host-` prefixed on https (the
 *  only one read there), the bare name on plain http (a loopback test). */
export function oidcCookieName(req: Request, base: string): string {
  return secureCookies(req) ? `__Host-${base}` : base;
}
export const OIDC_FLOW_TTL_SECONDS = 10 * 60;
/** A ticket after a password sign-in that made a session (the one-click
 *  offer), and a held one (required mode, no session). Each is used up when
 *  a link starts on it. */
export const OIDC_TICKET_TTL_SECONDS = 5 * 60;
export const OIDC_HELD_TICKET_TTL_SECONDS = 5 * 60;
/** The longest MCP consent query string a fresh flow carries: a cookie holds
 *  about 4 KB, and the rest of the flow must fit beside it. */
export const OIDC_CONSENT_QUERY_MAX = 1500;

/** Where a flow handed to a client ends: the client's redirect target and
 *  its S256 challenge (handoff.ts). */
export type FlowHandoff = Readonly<{ redirect: string; challenge: string }>;

/** What a flow is for: a sign-in, a link for one login, or a fresh sign-in
 *  that confirms one login in place of its password. */
export type OidcFlow = FlowSecrets &
  Readonly<{ handoff?: FlowHandoff }> &
  (
    | Readonly<{ purpose: 'signin'; returnTo: string }>
    | Readonly<{
        purpose: 'link';
        returnTo: string;
        loginId: string;
        epoch: number;
        /** The link started on a held ticket (required mode, no session):
         *  the callback signs the login in once it is linked. */
        held: boolean;
        /** When the link started (seconds): the provider's sign-in must not
         *  be older (provider.ts, auth_time). */
        startedAt: number;
      }>
    | Readonly<{
        purpose: 'fresh';
        returnTo: string;
        loginId: string;
        epoch: number;
        startedAt: number;
        /** The MCP consent page's query string, which the flow returns to
         *  when no client holds it (handoff absent). */
        consent?: string;
      }>
  );

/** A ticket: the login that just signed in with its password, its session
 *  epoch then, and whether it holds no session (required mode). */
export type OidcTicket = Readonly<{ loginId: string; epoch: number; held: boolean }>;

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
const epochOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/**
 * A path the callback may send the browser back to: a same-origin path
 * only ('/' then not a second '/' or '\'), no control characters, at most
 * 512 characters. Anything else is '/'.
 */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return '/';
  // A path that resolves to another '//' start ('/..//host') is no path of
  // this brain's either.
  const path = new URL(raw, 'http://brain.invalid').pathname;
  if (path.startsWith('//')) return '/';
  // A page, never an API route (a mailed start whose return is the start
  // itself would loop through the provider).
  if (path === '/api' || path.startsWith('/api/')) return '/';
  return raw;
}

function setCookie(
  res: NextResponse,
  req: Request,
  name: string,
  value: string,
  maxAge: number,
  sameSite: 'lax' | 'strict',
): void {
  res.cookies.set(oidcCookieName(req, name), value, {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite,
    path: OIDC_COOKIE_PATH,
    maxAge,
  });
}

/** Set the flow cookie for one flow. */
export function setFlowCookie(res: NextResponse, req: Request, flow: OidcFlow): void {
  const claims: Record<string, unknown> = {
    k: 'o',
    p: flow.purpose,
    st: flow.state,
    n: flow.nonce,
    cv: flow.codeVerifier,
    r: safeReturnPath(flow.returnTo),
  };
  if (flow.handoff) {
    claims.hr = flow.handoff.redirect;
    claims.hc = flow.handoff.challenge;
  }
  if (flow.purpose === 'link') {
    claims.uid = flow.loginId;
    claims.ep = flow.epoch;
    claims.h = flow.held ? 1 : 0;
    claims.at = flow.startedAt;
  }
  if (flow.purpose === 'fresh') {
    claims.uid = flow.loginId;
    claims.ep = flow.epoch;
    claims.at = flow.startedAt;
    if (flow.consent) claims.cq = flow.consent;
  }
  const { value } = signClaims(claims, OIDC_FLOW_TTL_SECONDS);
  setCookie(res, req, OIDC_FLOW_COOKIE, value, OIDC_FLOW_TTL_SECONDS, 'lax');
}

/** The request's flow, or null (none, forged, expired or malformed). */
export function readFlowCookie(req: Request): OidcFlow | null {
  for (const raw of cookieValues(
    req.headers.get('cookie'),
    oidcCookieName(req, OIDC_FLOW_COOKIE),
  )) {
    const c = verifySigned(raw, 'o');
    if (!c) continue;
    const state = str(c.st, 200);
    const nonce = str(c.n, 200);
    const codeVerifier = str(c.cv, 200);
    if (!state || !nonce || !codeVerifier) continue;
    const returnTo = safeReturnPath(c.r);
    const redirect = str(c.hr, 512);
    const challenge = str(c.hc, 64);
    const handoff = redirect && challenge ? { handoff: { redirect, challenge } } : {};
    const base = { returnTo, state, nonce, codeVerifier, ...handoff };
    if (c.p === 'signin') return { purpose: 'signin', ...base };
    if (c.p === 'link' || c.p === 'fresh') {
      const loginId = str(c.uid, 64);
      const epoch = epochOf(c.ep);
      const startedAt = epochOf(c.at);
      if (!loginId || epoch === null || startedAt === null) continue;
      if (c.p === 'fresh') {
        const consent = str(c.cq, OIDC_CONSENT_QUERY_MAX);
        return {
          purpose: 'fresh',
          ...base,
          loginId,
          epoch,
          startedAt,
          ...(consent ? { consent } : {}),
        };
      }
      if (c.h !== 0 && c.h !== 1) continue;
      return { purpose: 'link', ...base, loginId, epoch, held: c.h === 1, startedAt };
    }
  }
  return null;
}

/** A signed ticket: the cookie's value, or a token login's body field. */
export function signTicket(t: OidcTicket): { value: string; ttl: number } {
  const ttl = t.held ? OIDC_HELD_TICKET_TTL_SECONDS : OIDC_TICKET_TTL_SECONDS;
  const { value } = signClaims({ k: 'h', uid: t.loginId, ep: t.epoch, h: t.held ? 1 : 0 }, ttl);
  return { value, ttl };
}

/** Set the ticket cookie: `loginId` signed in with its password just now. */
export function setTicketCookie(res: NextResponse, req: Request, t: OidcTicket): void {
  const { value, ttl } = signTicket(t);
  setCookie(res, req, OIDC_TICKET_COOKIE, value, ttl, 'strict');
}

/** Clear the ticket (used up by a link start, or a sign out). */
export function clearTicketCookie(res: NextResponse, req: Request): void {
  setCookie(res, req, OIDC_TICKET_COOKIE, '', 0, 'strict');
}

/** A signed ticket's value read back, or null. */
export function ticketFromValue(raw: string): OidcTicket | null {
  const c = verifySigned(raw, 'h');
  if (!c) return null;
  const loginId = str(c.uid, 64);
  const epoch = epochOf(c.ep);
  if (!loginId || epoch === null || (c.h !== 0 && c.h !== 1)) return null;
  return { loginId, epoch, held: c.h === 1 };
}

/** The request's ticket, or null. Its epoch is checked against the login
 *  row by the caller (flow.ts linkStarter). */
export function readTicketCookie(req: Request): OidcTicket | null {
  for (const raw of cookieValues(
    req.headers.get('cookie'),
    oidcCookieName(req, OIDC_TICKET_COOKIE),
  )) {
    const t = ticketFromValue(raw);
    if (t) return t;
  }
  return null;
}

/** Clear both cookies (a finished or failed flow). */
export function clearOidcCookies(res: NextResponse, req: Request): void {
  setCookie(res, req, OIDC_FLOW_COOKIE, '', 0, 'lax');
  setCookie(res, req, OIDC_TICKET_COOKIE, '', 0, 'strict');
}

/** Clear the flow cookie only. */
export function clearFlowCookie(res: NextResponse, req: Request): void {
  setCookie(res, req, OIDC_FLOW_COOKIE, '', 0, 'lax');
}
