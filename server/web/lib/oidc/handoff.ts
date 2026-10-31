/**
 * Handing a company sign-in to a client (docs/oidc-sign-in.md). The web app,
 * the desktop app and the phone all hold a bearer, and the provider's sign-in
 * runs in a browser, so the callback cannot give them a cookie. The client
 * makes a PKCE verifier and sends its S256 challenge and where the flow ends;
 * the callback sends a one-time code there; the client spends the code with
 * the verifier. A code in the wrong hands is worth nothing, so a custom
 * scheme, which any app may claim, is a safe place to send one.
 *
 * Only the targets below are ever redirected to: a mailed start URL cannot
 * send a code anywhere else.
 *
 * A start ticket carries a flow that begins on a session (a link, a fresh
 * sign-in) to whichever browser opens it, since a bearer client's own request
 * cannot set that browser's flow cookie. It starts one flow for one login,
 * and proves nothing by itself: a link made from it needs the client's
 * verifier, and a fresh sign-in must come back as the same provider account.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { signClaims, verifySigned } from '@mantle/crypto';
import { env } from '@mantle/config';
import type { OidcCallbackResult, OidcHandoffPurpose } from '@mantle/client-types';
import { namedCorsOrigins } from '@/lib/auth/preflight';
import { OIDC_CONSENT_QUERY_MAX, type FlowHandoff } from './cookies';
import { isLoopbackHost } from './provider';
import type { OidcOn } from './settings';

/** The one app target: the desktop app and the phone. */
export const APP_REDIRECT = 'mantle://oidc';
/** How long a one-time code lasts, seconds. */
export const HANDOFF_CODE_TTL_SECONDS = 2 * 60;
/** How long a start ticket lasts: the browser opens it at once. */
const START_TICKET_TTL_SECONDS = 5 * 60;

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** A web target's origin the brain trusts: its own public origin, the
 *  client's, or a named cross-origin caller (never the '*' wildcard). */
function trustedOrigins(s: OidcOn): Set<string> {
  const client = (env('MANTLE_CLIENT_ORIGIN') ?? '').replace(/\/+$/, '');
  return new Set([
    new URL(s.redirectUri).origin,
    ...(client ? [client] : []),
    ...namedCorsOrigins(),
  ]);
}

/** `raw` when the flow may end there, else null. No fragment (the flow's
 *  own goes there) and no user info. */
export function handoffTarget(s: OidcOn, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  if (raw === APP_REDIRECT) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) return null;
  return trustedOrigins(s).has(url.origin) ? raw : null;
}

/** The handoff a client asked for, or null when either part is not one. */
export function readHandoff(s: OidcOn, redirect: unknown, challenge: unknown): FlowHandoff | null {
  const target = handoffTarget(s, redirect);
  if (!target || typeof challenge !== 'string' || !CHALLENGE.test(challenge)) return null;
  return { redirect: target, challenge };
}

/** The flow's end at the client: a code, or why it stopped. In the fragment:
 *  it never reaches a server, a log or a Referer. */
export function handoffCodeUrl(h: FlowHandoff, code: string, purpose: OidcHandoffPurpose): string {
  return `${h.redirect}#oidc=code&code=${code}&purpose=${purpose}`;
}
export function handoffFailedUrl(h: FlowHandoff, result: OidcCallbackResult): string {
  return `${h.redirect}#oidc=${result}`;
}

/** A new one-time code and the hash that is kept. */
export function newHandoffCode(): { code: string; hash: string } {
  const code = randomBytes(32).toString('base64url');
  return { code, hash: handoffCodeHash(code) };
}

export function handoffCodeHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Whether `verifier` is the one `challenge` was made from (S256). */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const made = createHash('sha256').update(verifier, 'ascii').digest();
  const want = Buffer.from(challenge, 'base64url');
  return made.length === want.length && timingSafeEqual(made, want);
}

/** A flow a start ticket begins in the browser that opens it. */
export type StartTicket = Readonly<
  | { purpose: 'link'; loginId: string; epoch: number; held: boolean; handoff: FlowHandoff }
  | {
      purpose: 'fresh';
      loginId: string;
      epoch: number;
      handoff?: FlowHandoff;
      consent?: string;
    }
>;

export function signStartTicket(t: StartTicket): string {
  const { value } = signClaims(
    {
      k: 's',
      p: t.purpose,
      uid: t.loginId,
      ep: t.epoch,
      ...(t.handoff ? { hr: t.handoff.redirect, hc: t.handoff.challenge } : {}),
      ...(t.purpose === 'link' ? { h: t.held ? 1 : 0 } : {}),
      ...(t.purpose === 'fresh' && t.consent ? { cq: t.consent } : {}),
    },
    START_TICKET_TTL_SECONDS,
  );
  return value;
}

/** The start ticket in `raw`, or null (forged, expired or malformed). */
export function readStartTicket(raw: string): StartTicket | null {
  const c = verifySigned(raw, 's');
  if (!c || typeof c.uid !== 'string' || typeof c.ep !== 'number') return null;
  const handoff =
    typeof c.hr === 'string' && typeof c.hc === 'string'
      ? { redirect: c.hr, challenge: c.hc }
      : undefined;
  if (c.p === 'link') {
    if (!handoff || (c.h !== 0 && c.h !== 1)) return null;
    return { purpose: 'link', loginId: c.uid, epoch: c.ep, held: c.h === 1, handoff };
  }
  if (c.p !== 'fresh') return null;
  const consent =
    typeof c.cq === 'string' && c.cq.length <= OIDC_CONSENT_QUERY_MAX ? c.cq : undefined;
  if (!handoff && !consent) return null;
  return {
    purpose: 'fresh',
    loginId: c.uid,
    epoch: c.ep,
    ...(handoff ? { handoff } : {}),
    ...(consent ? { consent } : {}),
  };
}
