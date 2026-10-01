/**
 * Login roles on the wire (client logins, Phase C0). Three roles: an admin,
 * a member (the team) and a client (a person at the brain's one client
 * company). A route that is not for the caller's role answers 403 with one
 * of the reasons below; a client never falls through to an admin answer.
 */

/** Who a login is. The brain reads it from the login row on every request. */
export type LoginKind = 'admin' | 'member' | 'client';

/** The `reason` of a 403 a gate answers a login of the wrong role with:
 *  `member-login` from an admin route, `admin-login` from a member route,
 *  `client-login` from any route that is not a client route. */
export type LoginRefusedReason = 'member-login' | 'admin-login' | 'client-login';

/** The body of that 403. */
export type LoginRefused = {
  error: 'forbidden';
  reason: LoginRefusedReason;
  message: string;
};

/** The 400 POST /api/users/:id/password answers when the target does not sign
 *  in with a password: a client (a link or a code) or a role this brain does
 *  not know. An admin's or a member's password can be reset. */
export type PasswordResetRefused = {
  error: string;
  reason: 'not-a-password-login';
  message: string;
};
