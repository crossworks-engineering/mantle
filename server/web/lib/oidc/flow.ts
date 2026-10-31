/**
 * Company sign-in, the routes' logic (docs/oidc-sign-in.md). The route
 * files under app/api/auth/oidc and app/api/users only declare their
 * policy and call here.
 *
 * Off (the default): every route here answers as if it were not there (a
 * 404), except the public config read, which says `{ mode: 'off' }`, and
 * the status read, which says the same. Nothing reads the database or calls
 * a provider.
 *
 * Sign-in: start (state, nonce and PKCE in the signed flow cookie) to the
 * provider and back to the callback, which signs in the login the account
 * is linked to, with a session of MANTLE_OIDC_SESSION_HOURS. Company
 * sign-in never makes a login and never links by email.
 *
 * Link: a signed-in login (on its cookie session) starts a link with the
 * ticket its password sign-in set on this browser, or with its password
 * typed again; a held login (required mode, no session) starts it on its
 * held ticket. The callback links the provider account to that login, and
 * signs a held login in.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import type {
  OidcAdminSummaryDTO,
  OidcCallbackResult,
  OidcConfigDTO,
  OidcLinkStarted,
  OidcOfferDismissed,
  OidcRefusal,
  OidcStatusDTO,
} from '@mantle/client-types';
import {
  endLoginSessions,
  setSessionCookie,
  stampCompanySignIn,
  unauthorizedRefusal,
  verifyPasswordForUse,
} from '@/lib/auth';
import type { Login } from '@/lib/auth/login';
import { passwordChangeRequiredBody } from '@/lib/auth/password-hold';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readJson } from '@/lib/read-body';
import { forgetRelayDevices } from '@/lib/push/store';
import { rateLimitLogin, rateLimitLoginRefund } from '@/lib/rate-limit';
import { rateLimitedResponse } from '@/lib/route-limits';
import {
  clearFlowCookie,
  clearOidcCookies,
  clearTicketCookie,
  readFlowCookie,
  readTicketCookie,
  safeReturnPath,
  setFlowCookie,
  type OidcFlow,
} from './cookies';
import {
  authorizationUrl,
  identityFromCallback,
  issuerKey,
  newFlowSecrets,
  type ProviderIdentity,
} from './provider';
import { forgetHolds, outsideHonoured } from './hold';
import { notifyLinkMade } from './notify';
import { oidcSettings, type OidcOn } from './settings';
import {
  activeLoginsWithLinks,
  createLink,
  dismissOffer,
  loginHasPassword,
  loginIsAdminUser,
  loginLinked,
  loginOidcState,
  oidcLoginRow,
  oidcRuleFacts,
  removeLink,
  setOutside,
  signInTarget,
  touchLink,
} from './store';

/** The login a public row reads (publicLoginItself), passed in by the
 *  route handler, which alone may read it (the manifest generator reads the
 *  route files). Called only once the mode is on. */
export type LoginReader = () => Promise<Login | null>;

/** The login's password tries at a link start: 5 in 15 minutes. */
const LINK_PASSWORD_RATE = { max: 5, windowMs: 15 * 60_000 };

/** End a login's sessions (its keys and links stay) and tell the push
 *  relay about the devices that went with them. */
async function endSessionsOf(loginId: string, actorId?: string): Promise<void> {
  const routing: string[] = [];
  await endLoginSessions(loginId, {
    removedRoutingTokens: routing,
    ...(actorId ? { actorId } : {}),
  });
  if (routing.length > 0) await forgetRelayDevices(routing);
}

/** How long a dismissed offer stays hidden. */
export const OFFER_DISMISS_DAYS = 7;

/** The answer of a company sign-in route while the mode is off: as if the
 *  route were not there. */
export function oidcOffAnswer(): NextResponse {
  return NextResponse.json({ error: 'Not found.' }, { status: 404 });
}

function json<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

function refusal(status: number, body: OidcRefusal): NextResponse {
  return json(body, status);
}

/** An absolute URL on this brain's public origin. It always carries a
 *  fragment (an empty one at least): a browser keeps the fragment of the
 *  request across a redirect whose Location has none, so a code a provider
 *  sent in one (response_mode=fragment) never rides on to the next page. */
function onBrain(s: OidcOn, path: string, result?: OidcCallbackResult): string {
  const url = new URL(safeReturnPath(path), new URL(s.redirectUri).origin);
  if (result) url.searchParams.set('oidc', result);
  const href = url.toString();
  return url.hash ? href : `${href}#`;
}

function redirect(url: URL | string): NextResponse {
  return NextResponse.redirect(url, 302);
}

// ── Public reads ────────────────────────────────────────────────────────────

/** GET /api/auth/oidc/config: the mode and the button's label. */
export function oidcConfigAnswer(): NextResponse {
  const s = oidcSettings();
  const body: OidcConfigDTO = s.mode === 'off' ? { mode: 'off' } : { mode: s.mode, label: s.label };
  return json(body);
}

/** Whether `login` may unlink itself: optional mode, or a login that keeps
 *  its password in required mode (the original account, an outside one). */
function mayUnlink(s: OidcOn, owner: boolean, outside: boolean): boolean {
  return s.mode === 'optional' || owner || outside;
}

/** GET /api/auth/oidc/status: the signed-in login's company sign-in. */
export async function oidcStatusAnswer(readLogin: LoginReader): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return json<OidcStatusDTO>({ mode: 'off' });
  const login = await readLogin();
  if (!login) return unauthorizedRefusal();
  const [facts, state] = await Promise.all([
    oidcRuleFacts(login.loginId, issuerKey(s.issuer)),
    loginOidcState(login.loginId),
  ]);
  const owner = facts?.owner === true;
  const linked = facts?.linked === true;
  // The mark as the rule reads it (hold.ts outsideHonoured).
  const outside = !!facts && outsideHonoured(s, facts);
  const dismissed = !!state.offerDismissedUntil && state.offerDismissedUntil.getTime() > Date.now();
  const body: OidcStatusDTO = {
    mode: s.mode,
    label: s.label,
    linked,
    owner,
    outside,
    offer: !linked && !outside && !dismissed,
    linkRequired: s.mode === 'required' && !linked && !owner && !outside,
    canUnlink: linked && mayUnlink(s, owner, outside),
  };
  return json(body);
}

/** POST /api/auth/oidc/offer: hide the link offer for 7 days. */
export async function oidcDismissOffer(
  req: Request,
  readLogin: LoginReader,
): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return oidcOffAnswer();
  const login = await readLogin();
  if (!login) return unauthorizedRefusal();
  const until = new Date(Date.now() + OFFER_DISMISS_DAYS * 24 * 3600 * 1000);
  await dismissOffer(login.loginId, until);
  auditFireAndForget({
    actorId: login.loginId,
    actorEmail: login.email,
    action: 'auth.oidc_offer_dismissed',
    method: 'POST',
    path: '/api/auth/oidc/offer',
    ...requestMetaFrom(req),
  });
  return json<OidcOfferDismissed>({ ok: true, until: until.toISOString() });
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

/** GET /api/auth/oidc/start?return=<path>: off to the provider. */
export async function oidcStartSignIn(req: Request): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return oidcOffAnswer();
  const returnTo = safeReturnPath(new URL(req.url).searchParams.get('return'));
  const secrets = newFlowSecrets();
  let url: string;
  try {
    url = await authorizationUrl(s, secrets);
  } catch (err) {
    log('auth').warn(`company sign-in: the provider could not be read: ${errorMessage(err)}`);
    return redirect(onBrain(s, '/login', 'unavailable'));
  }
  const res = redirect(url);
  setFlowCookie(res, req, { purpose: 'signin', returnTo, ...secrets });
  return res;
}

/** Sign `loginId` in on `res` with a company sign-in session. */
async function mintSsoSession(
  res: NextResponse,
  req: Request,
  s: OidcOn,
  row: { id: string; email: string; sessionEpoch: number },
  how: 'signin' | 'link',
): Promise<void> {
  await stampCompanySignIn(row.id);
  setSessionCookie(res, req, row.id, row.sessionEpoch, {
    ttlSeconds: s.sessionSeconds,
    oidc: true,
  });
  auditFireAndForget({
    actorId: row.id,
    actorEmail: row.email,
    action: 'auth.login',
    method: 'GET',
    path: '/api/auth/oidc/callback',
    detail: { channel: 'oidc', via: how },
    ...requestMetaFrom(req),
  });
}

/** Where a failed flow sends the browser: a sign-in (or a held link, which
 *  has no session to go back to) to the sign-in screen, an in-session link
 *  back where it started. */
function flowFailed(
  req: Request,
  s: OidcOn,
  flow: OidcFlow | null,
  result: OidcCallbackResult,
  who: { identity?: ProviderIdentity; loginId?: string; email?: string } = {},
): NextResponse {
  // A row per failed callback once a provider account came back (its issuer
  // and subject: no secret), so an admin can tell who tried. A callback with
  // no verified account (cancelled, a token that did not verify) writes
  // none: anyone can send one, and the failure is in the log.
  if (who.identity)
    auditFireAndForget({
      actorId: who.loginId ?? (flow?.purpose === 'link' ? flow.loginId : null),
      actorEmail: who.email ?? '(company sign-in)',
      action: 'auth.login_failed',
      method: 'GET',
      path: '/api/auth/oidc/callback',
      detail: {
        channel: 'oidc',
        reason: result,
        purpose: flow?.purpose ?? null,
        ...(who.identity ? { issuer: who.identity.issuer, subject: who.identity.subject } : {}),
      },
      ...requestMetaFrom(req),
    });
  const inSession = flow?.purpose === 'link' && !flow.held;
  const res = redirect(onBrain(s, inSession ? flow.returnTo : '/login', result));
  clearFlowCookie(res, req);
  return res;
}

/** GET /api/auth/oidc/callback: back from the provider. */
export async function oidcCallback(req: Request, readLogin: LoginReader): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return oidcOffAnswer();
  // Read first, always: the row's limit (oidcCallback) is taken at this
  // read, for a sign-in as much as for an in-session link.
  const login = await readLogin();
  const flow = readFlowCookie(req);
  // No flow on this browser: nothing to end and no row to write (anyone can
  // send this request).
  if (!flow) return redirect(onBrain(s, '/login', 'expired'));
  const query = new URL(req.url).searchParams;
  // Not this browser's flow (another site sent it here, or a stale tab):
  // it ends nothing and writes no row naming the login.
  if (query.get('state') !== flow.state) return redirect(onBrain(s, '/login', 'failed'));
  // The provider said no (the person cancelled, or is not assigned the
  // app): its text is never shown.
  if (query.has('error')) return flowFailed(req, s, flow, 'cancelled');
  let identity: ProviderIdentity;
  try {
    identity = await identityFromCallback(
      s,
      query,
      flow,
      flow.purpose === 'link' ? { linkStartedAt: flow.startedAt } : {},
    );
  } catch (err) {
    log('auth').warn(`company sign-in: the callback did not verify: ${errorMessage(err)}`);
    return flowFailed(req, s, flow, 'failed');
  }
  return flow.purpose === 'signin'
    ? signInLinked(req, s, flow, identity)
    : finishLink(req, s, flow, identity, login);
}

async function signInLinked(
  req: Request,
  s: OidcOn,
  flow: OidcFlow,
  identity: ProviderIdentity,
): Promise<NextResponse> {
  const target = await signInTarget(identity.issuer, identity.subject);
  if (!target) return flowFailed(req, s, flow, 'not-linked', { identity });
  const { row } = target;
  const link = { id: target.linkId };
  if (!row.usable) {
    return flowFailed(req, s, flow, 'not-allowed', {
      identity,
      loginId: row.id,
      email: row.email,
    });
  }
  const res = redirect(onBrain(s, flow.returnTo));
  await mintSsoSession(res, req, s, row, 'signin');
  // The last-use stamp is bookkeeping: a failure never fails the sign-in.
  await touchLink(link.id).catch((err: unknown) =>
    log('auth').warn(`company sign-in: the link's last use was not stamped: ${errorMessage(err)}`),
  );
  clearOidcCookies(res, req);
  return res;
}

async function finishLink(
  req: Request,
  s: OidcOn,
  flow: Extract<OidcFlow, { purpose: 'link' }>,
  identity: ProviderIdentity,
  login: Login | null,
): Promise<NextResponse> {
  const row = await oidcLoginRow(flow.loginId);
  // The login must be as it was when the link started: a password change,
  // a sign out everywhere or a disable since then ends the flow.
  if (!row?.usable || row.sessionEpoch !== flow.epoch) {
    return flowFailed(req, s, flow, 'expired', { identity });
  }
  if (!flow.held) {
    // An in-session link finishes in the session that started it.
    if (!login || login.loginId !== flow.loginId || login.source !== 'web') {
      return flowFailed(req, s, flow, 'expired', { identity, loginId: flow.loginId });
    }
  }
  const result = await createLink(row.id, flow.epoch, identity);
  // The gate reads the link now, not a kept "unlinked" (hold.ts).
  forgetHolds(row.id);
  if (result !== 'linked') {
    return flowFailed(req, s, flow, result, { identity, loginId: row.id, email: row.email });
  }
  void notifyLinkMade(row.id);
  auditFireAndForget({
    actorId: row.id,
    actorEmail: row.email,
    action: 'auth.oidc_linked',
    method: 'GET',
    path: '/api/auth/oidc/callback',
    // Which provider account: its subject and the name it shows (display
    // only, never matched on), so an admin can tell who linked.
    detail: {
      issuer: identity.issuer,
      subject: identity.subject,
      display: identity.display,
      held: flow.held,
    },
    ...requestMetaFrom(req),
  });
  const res = redirect(onBrain(s, flow.returnTo, 'linked'));
  if (flow.held) await mintSsoSession(res, req, s, row, 'link');
  clearOidcCookies(res, req);
  return res;
}

// ── Link and unlink (the login itself) ──────────────────────────────────────

const LinkBody = z.object({
  password: z.string().min(1).max(1024).optional(),
  returnTo: z.string().max(512).optional(),
});

/** Who may start a link on this request, or the refusal. */
async function linkStarter(
  req: Request,
  login: Login | null,
  password: string | undefined,
): Promise<{ loginId: string; epoch: number; held: boolean } | NextResponse> {
  const ticket = readTicketCookie(req);
  if (login) {
    // The callback finishes on the browser's cookie session: a bearer
    // client (the phone, the split web client) links on the web.
    if (login.source !== 'web') {
      return json({ error: 'Link your company sign-in in the web app.' }, 400);
    }
    const fresh =
      !!ticket && ticket.loginId === login.loginId && ticket.epoch === login.sessionEpoch;
    if (!fresh) {
      if (!password) {
        return refusal(401, {
          error: 'Type your password to link your company sign-in.',
          code: 'password-needed',
        });
      }
      // The login's own failure budget around the password check, as at
      // key creation and MCP consent: every try counts before the check (so
      // parallel guesses cannot all pass), a right password gives its try
      // back. Named in eslint-rules/route-plumbing.mjs RATE_LIMIT_ALLOW.
      const bucket = `oidc-link-pw:${login.loginId}`;
      const tries = rateLimitLogin(bucket, LINK_PASSWORD_RATE);
      if (!tries.ok) return rateLimitedResponse(tries.retryAfterSec);
      // The box password rule checks the password typed here too, as at
      // key creation and MCP consent (verifyPasswordForUse): one that fails
      // it holds the login to the change step and starts no link.
      const checked = await verifyPasswordForUse(login.loginId, password);
      if (checked === 'wrong') {
        auditFireAndForget({
          actorId: login.loginId,
          actorEmail: login.email,
          action: 'auth.login_failed',
          method: 'POST',
          path: '/api/auth/oidc/link',
          detail: { channel: 'oidc-link', reason: 'password' },
          ...requestMetaFrom(req),
        });
        return json({ error: 'Current password is incorrect.' }, 401);
      }
      rateLimitLoginRefund(bucket);
      if (checked === 'held') return json(passwordChangeRequiredBody(), 403);
    }
    return { loginId: login.loginId, epoch: login.sessionEpoch, held: false };
  }
  // No session: only a held ticket (required mode, the password checked a
  // moment ago) may start a link, for its own login as it is now.
  if (ticket?.held) {
    // The login's own budget, as for a password: a held ticket is the proof
    // of one, and each start is counted.
    const tries = rateLimitLogin(`oidc-link-pw:${ticket.loginId}`, LINK_PASSWORD_RATE);
    if (!tries.ok) return rateLimitedResponse(tries.retryAfterSec);
    const row = await oidcLoginRow(ticket.loginId);
    if (row?.usable && row.sessionEpoch === ticket.epoch) {
      return { loginId: row.id, epoch: row.sessionEpoch, held: true };
    }
  }
  return unauthorizedRefusal();
}

/** POST /api/auth/oidc/link: start linking the login to a company account. */
export async function oidcStartLink(req: Request, readLogin: LoginReader): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return oidcOffAnswer();
  // Read first: the row's limit is taken here, before any password check.
  const login = await readLogin();
  const parsed = LinkBody.safeParse((await readJson(req)) ?? {});
  if (!parsed.success) return json({ error: 'Invalid input.' }, 400);
  const who = await linkStarter(req, login, parsed.data.password);
  if (who instanceof NextResponse) return who;
  if (await loginLinked(who.loginId, issuerKey(s.issuer))) {
    return refusal(409, { error: 'This login is linked already.', code: 'already-linked' });
  }
  const secrets = newFlowSecrets();
  let url: string;
  try {
    url = await authorizationUrl(s, secrets, { link: true });
  } catch (err) {
    log('auth').warn(`company sign-in: the provider could not be read: ${errorMessage(err)}`);
    return json({ error: 'Company sign-in is not reachable now. Try again later.' }, 503);
  }
  auditFireAndForget({
    actorId: who.loginId,
    actorEmail: login?.email ?? '(company sign-in)',
    action: 'auth.oidc_link_started',
    method: 'POST',
    path: '/api/auth/oidc/link',
    detail: { held: who.held },
    ...requestMetaFrom(req),
  });
  const res = json<OidcLinkStarted>({ url });
  // The ticket is used up: a second link start needs a new sign-in or the
  // password.
  clearTicketCookie(res, req);
  setFlowCookie(res, req, {
    purpose: 'link',
    returnTo: safeReturnPath(parsed.data.returnTo ?? '/'),
    ...secrets,
    loginId: who.loginId,
    epoch: who.epoch,
    held: who.held,
    startedAt: Math.floor(Date.now() / 1000),
  });
  return res;
}

/** DELETE /api/auth/oidc/link: the login removes its own link (optional
 *  mode, or a login that keeps its password). Its password is then its
 *  only way in. */
export async function oidcUnlinkSelf(req: Request, readLogin: LoginReader): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return oidcOffAnswer();
  const login = await readLogin();
  if (!login) return unauthorizedRefusal();
  const facts = await oidcRuleFacts(login.loginId, issuerKey(s.issuer));
  if (!facts) return unauthorizedRefusal();
  // The mark as the rule reads it (hold.ts outsideHonoured), never the raw
  // column: a mark the operator no longer allows, or on an Admin user,
  // keeps no password and so lets no one unlink in required mode.
  if (!mayUnlink(s, facts.owner, outsideHonoured(s, facts))) {
    return refusal(403, {
      error: 'Company sign-in is required on this site. Ask an admin to remove the link.',
      code: 'sso-required',
    });
  }
  if (!(await loginHasPassword(login.loginId))) {
    return json({ error: 'Set a password before you remove the link.' }, 409);
  }
  const removed = await removeLink(login.loginId, issuerKey(s.issuer));
  forgetHolds(login.loginId);
  // Always a row, written before the session end (which may fail and be
  // retried): whether a link went.
  auditFireAndForget({
    actorId: login.loginId,
    actorEmail: login.email,
    action: 'auth.oidc_unlinked',
    method: 'DELETE',
    path: '/api/auth/oidc/link',
    detail: { removed },
    ...requestMetaFrom(req),
  });
  // What the link signed in ends with it, in either mode (keys stay; the
  // password is the way back in, plan section 17.4). Whether or not a row
  // went now: a retry after a failed end still ends the sessions.
  await endSessionsOf(login.loginId);
  return json({ ok: true, unlinked: removed });
}

// ── The users area ──────────────────────────────────────────────────────────

/** GET /api/users/oidc: who is linked, with the counts. */
export async function oidcAdminSummary(): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return json<OidcAdminSummaryDTO>({ mode: 'off' });
  const logins = await activeLoginsWithLinks(issuerKey(s.issuer));
  // Counted with the rule's own predicate (hold.ts): a mark the operator
  // does not allow, or one on an Admin user, keeps no password.
  const honoured = (l: (typeof logins)[number]) => outsideHonoured(s, l);
  const body: OidcAdminSummaryDTO = {
    mode: s.mode,
    label: s.label,
    outsideAllowed: s.outsideAllowed,
    counts: {
      active: logins.length,
      linked: logins.filter((l) => l.linked).length,
      unlinked: logins.filter((l) => !l.linked && !l.owner && !honoured(l)).length,
      outside: logins.filter((l) => !l.linked && honoured(l)).length,
    },
    logins: logins.map((l) => ({ ...l })),
  };
  return json(body);
}

const OutsideBody = z.object({ outside: z.boolean() });

/** PATCH /api/users/:id/oidc { outside }: mark or clear an outside person. */
export async function oidcAdminSetOutside(
  req: Request,
  targetId: string,
  actor: { id: string; email: string },
): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return oidcOffAnswer();
  const parsed = OutsideBody.safeParse((await readJson(req)) ?? {});
  if (!parsed.success) return json({ error: 'Send { outside: true or false }.' }, 400);
  const row = await oidcLoginRow(targetId);
  if (!row) return json({ error: 'User not found.' }, 404);
  // The mark gives a login its password back in required mode, so it is
  // for people outside the company only (decision D3): never the caller
  // itself, an Admin user (admins sign in with the company account; the
  // original account keeps its password anyway), or a login linked to a
  // company account. Clearing it is always allowed. The policy itself is
  // the operator's (.env); the boot names how many are marked.
  if (parsed.data.outside) {
    const why = !s.outsideAllowed
      ? 'Outside logins are turned off on this box (MANTLE_OIDC_OUTSIDE=off).'
      : targetId === actor.id
        ? 'You cannot mark your own login outside.'
        : row.isOwner
          ? 'The original account keeps its password already.'
          : (await loginIsAdminUser(targetId))
            ? 'An Admin user cannot be marked outside: admins sign in with the company account.'
            : (await loginLinked(targetId, issuerKey(s.issuer)))
              ? 'This login is linked to a company account: remove the link first.'
              : null;
    if (why) return json({ error: why }, 409);
  }
  await setOutside(targetId, parsed.data.outside);
  forgetHolds(targetId);
  // A mark cleared in required mode: the login's password sessions end now
  // (its links and keys stay), never only paused by the hold.
  if (!parsed.data.outside && s.mode === 'required') {
    await endSessionsOf(targetId, actor.id);
  }
  auditFireAndForget({
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'users.oidc_outside',
    method: 'PATCH',
    path: `/api/users/${targetId}/oidc`,
    detail: { targetId, outside: parsed.data.outside },
    ...requestMetaFrom(req),
  });
  return json({ ok: true, outside: parsed.data.outside });
}

/** DELETE /api/users/:id/oidc: remove a login's link (it signs in with its
 *  password again; in required mode it is asked to link). */
export async function oidcAdminUnlink(
  req: Request,
  targetId: string,
  actor: { id: string; email: string },
): Promise<NextResponse> {
  const s = oidcSettings();
  if (s.mode === 'off') return oidcOffAnswer();
  const row = await oidcLoginRow(targetId);
  if (!row) return json({ error: 'User not found.' }, 404);
  // The password is the way back in (plan section 17.4): a login with none
  // would be left with no way to sign in.
  if (!(await loginHasPassword(targetId))) {
    return json({ error: 'This user has no password. Set one before you remove the link.' }, 409);
  }
  const removed = await removeLink(targetId, issuerKey(s.issuer));
  forgetHolds(targetId);
  // Always a row, written before the session end (which may fail and be
  // retried): whether a link went, and that the sessions end.
  auditFireAndForget({
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'users.oidc_unlinked',
    method: 'DELETE',
    path: `/api/users/${targetId}/oidc`,
    detail: { targetId, removed },
    ...requestMetaFrom(req),
  });
  // A session the link made would live on for its hours: the login's
  // sessions end too (its keys stay; End sessions ends those), whether or
  // not a row went now (a retry after a failed end still ends them).
  await endSessionsOf(targetId, actor.id);
  return json({ ok: true, unlinked: removed });
}
