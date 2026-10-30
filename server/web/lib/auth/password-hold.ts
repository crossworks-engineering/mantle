/**
 * The password hold (plan "Corporate sign-in", section 6.4; docs/policy.md):
 * while the box policy sets a password rule (MANTLE_POLICY_PASSWORD_MIN) and
 * a login's must_change_password flag is set (a sign-in took a password that
 * fails the rule, password-rule.ts), the login reaches nothing but the
 * change-password step: every other route answers
 *
 *   403 { error: 'password_change_required', code: 'password_change_required',
 *         message, min, commonList }
 *
 * The gate asks this once per routed request, before the guard's answer
 * (server/middleware/gate.ts), so one check covers every route and every
 * credential the request's login is found by (a cookie, a device token, an
 * API key on /api/v1). MCP (lib/mcp-auth.ts) and a Telegram chat
 * (@mantle/telegram chat-login.ts) ask the same flag where they find their
 * login.
 *
 * With no password rule this returns at once and reads nothing: a box
 * without the policy runs every request exactly as before.
 */
import { passwordChangeHolds, passwordPolicyMin } from '@mantle/config';
import { authUsers, db, eq } from '@mantle/db';
import type { RouteRow } from './route-policy';
import type { RequestLogins } from './session';
import { passwordRule } from './password-rule';
import { CACHE_CONTROL } from '../cache-control';

/** The code every held answer carries (and a client keys its change-password
 *  screen on). */
export const PASSWORD_CHANGE_REQUIRED = 'password_change_required';

/** The routes a held login still reaches: the change itself, who it is (the
 *  client learns why it is held), signing out, and keeping its own session
 *  alive (a device token's refresh, the web client's cookie upgrade). */
export const PASSWORD_HOLD_OPEN: ReadonlySet<string> = new Set([
  'POST /api/auth/change-password',
  'GET /api/auth/whoami',
  'HEAD /api/auth/whoami',
  'POST /api/auth/logout',
  'POST /api/auth/mobile-logout',
  'POST /api/auth/token/refresh',
  'POST /api/auth/sso',
]);

/** The held answer's body. */
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

/**
 * The hold's answer for this request, or null to go on. Finds the request's
 * login (the same find every guard reads, kept for them: no second lookup);
 * a find that fails is kept for the guard, whose read answers that failure.
 */
export async function passwordHoldAnswer(
  row: Pick<RouteRow, 'key'>,
  logins: RequestLogins,
): Promise<Response | null> {
  if (passwordPolicyMin() === null) return null;
  if (PASSWORD_HOLD_OPEN.has(row.key)) return null;
  const finding = logins.login();
  let held: boolean;
  try {
    const found = await finding;
    held = passwordChangeHolds(found.resolved?.mustChangePassword);
  } catch {
    logins.keepFailure(finding);
    return null;
  }
  if (!held) return null;
  return Response.json(passwordChangeRequiredBody(), {
    status: 403,
    headers: { 'Cache-Control': CACHE_CONTROL.none },
  });
}

/** Whether the password hold holds `loginId` now (whoami's answer). With no
 *  password rule: false, and nothing is read. */
export async function loginHeldForPasswordChange(loginId: string): Promise<boolean> {
  if (passwordPolicyMin() === null) return false;
  const [row] = await db
    .select({ flag: authUsers.mustChangePassword })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return passwordChangeHolds(row?.flag);
}
