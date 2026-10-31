/**
 * The password hold (plan "Corporate sign-in", section 6.4; docs/policy.md).
 * While the box policy sets a password rule (MANTLE_POLICY_PASSWORD_MIN), a
 * login is held in one of two ways (@mantle/config passwordHoldState):
 *
 *  - 'change': its must_change_password flag is set (a sign-in or a password
 *    prompt took a password that fails the rule). It reaches nothing but the
 *    change-password step; every other route answers
 *      403 { error: 'password_change_required', code: 'password_change_required',
 *            message, min, commonList }
 *  - 'recheck': its password was never checked under this rule
 *    (password_checked_min null or lower: the rule went on, or up, since).
 *    Its sessions, keys and connectors answer as signed out (but signing
 *    out),
 *      401 { error: 'unauthorized', code: 'password_recheck_required', message }
 *    until it signs in with its password once (the sign-in routes are open:
 *    a public row that does not act as the login), which checks it.
 *
 * The gate asks this once per routed request, before the guard's answer
 * (server/middleware/gate.ts), so one check covers every route and every
 * credential the request's login is found by (a cookie, a device token, an
 * API key on /api/v1). MCP (lib/mcp-auth.ts) and a Telegram chat
 * (@mantle/telegram chat-login.ts) ask the same state where they find
 * their login.
 *
 * Company sign-in (docs/oidc-sign-in.md) decides which of those holds a
 * credential meets, by how it came (a password session, an SSO session, a
 * grant a session made): lib/oidc/hold.ts credentialPasswordHold, the same
 * facts its session gate reads. Where the password is no way in (required
 * mode, a linked login) nothing is held; an SSO session never meets the
 * recheck it could not clear.
 *
 * With no password rule this returns at once and reads nothing: a box
 * without the policy runs every request exactly as before.
 */
import {
  passwordHoldState,
  passwordPolicyMin,
  type CredentialKind,
  type PasswordHold,
} from '@mantle/config';
import { authUsers, db, eq } from '@mantle/db';
import { credentialPasswordHold } from '../oidc/hold';
import type { RouteCaller, RouteRow } from './route-policy';
import { requestLogins, type RequestLogins } from './session';
import { passwordRule } from './password-rule';

/** The code a 'change' hold answers with (a client keys its change-password
 *  screen on it). */
export const PASSWORD_CHANGE_REQUIRED = 'password_change_required';
/** The code a 'recheck' hold answers with (the client signs the person in
 *  again). */
export const PASSWORD_RECHECK_REQUIRED = 'password_recheck_required';

/** The public rows whose handler acts as the request's login (it reads the
 *  login at the read): the hold applies to them. Every other public row
 *  (sign-in, signup, invite accept, bootstrap-state, a share link) judges
 *  its own credential and acts as no login, so the hold leaves it alone. */
const PUBLIC_ACTS_AS_LOGIN: ReadonlySet<RouteCaller> = new Set([
  'publicLogin',
  'cookieUpgrade',
  'ownerAtRead',
]);

/** The 'change' answer's body. */
export function passwordChangeRequiredBody(): Record<string, unknown> {
  const rule = passwordRule();
  return {
    error: PASSWORD_CHANGE_REQUIRED,
    code: PASSWORD_CHANGE_REQUIRED,
    message: "Your password does not meet this box's password rule. Change it before you continue.",
    min: rule.min,
    commonList: rule.commonList,
  };
}

/** The 'recheck' answer's body. */
export function passwordRecheckRequiredBody(): Record<string, unknown> {
  return {
    error: 'unauthorized',
    code: PASSWORD_RECHECK_REQUIRED,
    message: 'This box has a new password rule. Sign in again with your password.',
  };
}

/**
 * The hold's answer for a state on a row, or null. A row says what a held
 * login still reaches in its own declaration (`passwordHold`,
 * route-declaration.ts): 'change-step' while it must change its password
 * (the change itself, whoami, keeping its session alive), 'sign-out' under
 * every hold. The gate's default answers no-store (apiCacheDefault).
 */
export function holdAnswer(
  state: PasswordHold,
  row: Pick<RouteRow, 'passwordHold'>,
): Response | null {
  if (state === null || row.passwordHold === 'sign-out') return null;
  if (state === 'change') {
    return row.passwordHold === 'change-step'
      ? null
      : Response.json(passwordChangeRequiredBody(), { status: 403 });
  }
  return Response.json(passwordRecheckRequiredBody(), { status: 401 });
}

/**
 * The hold's answer for this request, or null to go on. Finds the request's
 * login (the same find every guard reads, kept for them: no second lookup);
 * a find that fails is kept for the guard, whose read answers that failure.
 */
export async function passwordHoldAnswer(
  row: Pick<RouteRow, 'public' | 'caller' | 'passwordHold'>,
  logins: RequestLogins,
): Promise<Response | null> {
  if (passwordPolicyMin() === null) return null;
  if (row.public && !(row.caller && PUBLIC_ACTS_AS_LOGIN.has(row.caller))) return null;
  const finding = logins.login();
  let found: Awaited<typeof finding>;
  try {
    found = await finding;
  } catch {
    logins.keepFailure(finding);
    return null;
  }
  return holdAnswer(await foundHold(found.resolved), row);
}

/** The hold a found login's credential meets. */
async function foundHold(
  r: {
    loginId: string;
    mustChangePassword: boolean;
    passwordCheckedMin: number | null;
    credential: CredentialKind;
  } | null,
): Promise<PasswordHold> {
  if (!r) return null;
  const state = passwordHoldState(r.mustChangePassword, r.passwordCheckedMin);
  return credentialPasswordHold(r.loginId, state, r.credential);
}

/** The hold the request's own credential meets (whoami's answer): the
 *  login the gate found, as found. With no password rule: null, and
 *  nothing is read. */
export async function requestPasswordHold(): Promise<PasswordHold> {
  if (passwordPolicyMin() === null) return null;
  return foundHold((await requestLogins().login()).resolved);
}

/** The hold a grant (an MCP grant, an API key on MCP) of `loginId` meets
 *  now: MCP's refusal. With no password rule: null, and nothing is read. */
export async function grantPasswordHold(loginId: string): Promise<PasswordHold> {
  if (passwordPolicyMin() === null) return null;
  const [row] = await db
    .select({
      flag: authUsers.mustChangePassword,
      checkedMin: authUsers.passwordCheckedMin,
    })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return row
    ? credentialPasswordHold(loginId, passwordHoldState(row.flag, row.checkedMin), 'grant')
    : null;
}
