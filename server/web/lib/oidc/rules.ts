/**
 * The password sign-in half of company sign-in's required mode (the rule
 * itself: hold.ts passwordRule). Every route that signs in with a password
 * asks `passwordSignInRule` after the password is checked: /api/auth/login,
 * the three token logins (lib/token-login.ts) and the invite accept.
 * Off and optional: always 'allow', with no database read.
 */
import { NextResponse } from '@/server/http-compat';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { setTicketCookie } from './cookies';
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
 * The 403 for a password sign-in the rule refused. `ticket`: the cookie
 * login's (and the invite's) login and session epoch, so a 'link-required'
 * answer carries the held ticket the one link step starts on; the token
 * logins pass none (a bearer client links on the web).
 */
export function passwordRefusal(
  req: Request,
  rule: Exclude<PasswordRule, 'allow'>,
  at: { path: string; email: string; loginId: string; channel?: string },
  ticket?: { epoch: number },
): NextResponse {
  const s = oidcSettings();
  const label = s.mode === 'off' ? '' : s.label;
  const body: OidcRefusal =
    rule === 'sso-required'
      ? { error: `Sign in with ${label}.`, code: 'sso-required' }
      : ticket
        ? { error: 'Link your company sign-in to continue.', code: 'sso-link-required' }
        : {
            error: 'Link your company sign-in on the web first, then sign in here.',
            code: 'sso-link-required',
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
  if (rule === 'link-required' && ticket) {
    setTicketCookie(res, req, { loginId: at.loginId, epoch: ticket.epoch, held: true });
  }
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
