/**
 * The password sign-in half of company sign-in's required mode (the rule
 * itself: hold.ts passwordRule). Every route that signs in with a password
 * asks `passwordSignInRule` after the password is checked: /api/auth/login,
 * the three token logins (lib/token-login.ts) and the invite accept.
 * Off and optional: always 'allow', with no database read.
 */
import { NextResponse } from '@/server/http-compat';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { setTicketCookie, signTicket } from './cookies';
import { passwordRule, type PasswordRule } from './hold';
import { oidcSettings, type OidcSettings } from './settings';
import type { OidcRefusal } from '@mantle/client-types';

export type { PasswordRule };

/** What company sign-in says of a password sign-in by `loginId` (whose
 *  password was just checked). */
export function passwordSignInRule(
  loginId: string,
  s: OidcSettings = oidcSettings(),
): Promise<PasswordRule> {
  return passwordRule(loginId, s);
}

/**
 * The 403 for a password sign-in the rule refused. `ticket`: the login's
 * session epoch, so a 'link-required' answer carries the held ticket the one
 * link step starts on. The cookie login (and the invite) sets it as a cookie;
 * a token login, with `inBody`, answers it, for a bearer client to hand the
 * link to itself.
 */
export function passwordRefusal(
  req: Request,
  rule: Exclude<PasswordRule, 'allow'>,
  at: { path: string; email: string; loginId: string; channel?: string },
  ticket?: { epoch: number; inBody?: boolean },
): NextResponse {
  const s = oidcSettings();
  const label = s.mode === 'off' ? '' : s.label;
  const held = { loginId: at.loginId, epoch: ticket?.epoch ?? 0, held: true };
  const body: OidcRefusal =
    rule === 'sso-required'
      ? { error: `Sign in with ${label}.`, code: 'sso-required' }
      : {
          error: 'Link your company sign-in to continue.',
          code: 'sso-link-required',
          ...(ticket?.inBody ? { ticket: signTicket(held).value } : {}),
        };
  auditFireAndForget({
    actorId: at.loginId,
    actorEmail: at.email,
    action: 'auth.login_refused',
    method: 'POST',
    path: at.path,
    detail: { reason: rule, ...(at.channel ? { channel: at.channel } : {}) },
    ...requestMetaFrom(req),
  });
  const res = NextResponse.json(body, { status: 403 });
  if (rule === 'link-required' && ticket && !ticket.inBody) setTicketCookie(res, req, held);
  return res;
}

/**
 * After a password sign-in that made a session: the short ticket a link
 * may start on with no password typed again (the "link now" offer). Only
 * while company sign-in is on: off, the answer is the same bytes as before.
 */
export function offerTicketAfterPassword(
  res: NextResponse,
  req: Request,
  loginId: string,
  epoch: number,
): void {
  if (oidcSettings().mode === 'off') return;
  setTicketCookie(res, req, { loginId, epoch, held: false });
}

/** The same ticket for a token login's answer, for a client that holds no
 *  cookie (`oidcTicket`). Off: nothing, so the answer is the same bytes as
 *  before. */
export function offerTicketInBody(
  loginId: string,
  epoch: number | undefined,
): { oidcTicket?: string } {
  if (oidcSettings().mode === 'off' || epoch === undefined) return {};
  return { oidcTicket: signTicket({ loginId, epoch, held: false }).value };
}
