/**
 * Login kinds on the wire. Two: an admin and a member. There is no client
 * login and no email-code sign-in: a login carries no
 * permission of its own, what it reads and may do comes from its
 * workspaces. A route that is not for the caller's kind answers 403 with
 * one of the reasons below.
 */

import type { LoginRole } from '../role-names';

/** Who a login is. The brain reads it from the login row on every request.
 *  The login roles (LOGIN_ROLES, ../role-names). */
export type LoginKind = LoginRole;

/** The `reason` of a 403 a gate answers a login of the wrong kind with:
 *  `member-login` from an admin route, `admin-login` from a member route. */
export type LoginRefusedReason = 'member-login' | 'admin-login';

/** The body of that 403. */
export type LoginRefused = {
  error: 'forbidden';
  reason: LoginRefusedReason;
  message: string;
};

/** The 400 POST /api/users/:id/password answers when the target does not sign
 *  in with a password: a role this brain does not know. An admin's or a
 *  member's password can be reset. */
export type PasswordResetRefused = {
  error: string;
  reason: 'not-a-password-login';
  message: string;
};
