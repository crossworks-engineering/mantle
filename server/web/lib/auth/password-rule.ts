/**
 * THE password rule: one function for every password a login is given (a
 * signup, the first owner, an invite accept, an Admin's new login or reset,
 * a login's own change, the onboard script), and the one place a sign-in
 * asks whether the password it just took still meets the rule.
 *
 * With no box policy (MANTLE_POLICY_PASSWORD_MIN empty) the rule is today's,
 * exactly: at least 8 characters, at most 1024, no list, and a sign-in never
 * sets the forced change. With a policy: at least that many characters, and
 * not a common password (a bundled list, no outside call, no symbol rules;
 * plan "Corporate sign-in", section 6.4). docs/policy.md.
 *
 * Phase 4 (company sign-in) hooks in here: a login that signs in through the
 * company's provider sets no password, and this stays the only rule for the
 * ones that do.
 */
import { DEFAULT_PASSWORD_MIN, passwordPolicyMin } from '@mantle/config';

import { authUsers } from '@mantle/db';
import { defineDomainError } from '@mantle/std';
import { COMMON_PASSWORD_BASES, COMMON_PASSWORDS } from './common-passwords';

/** The longest password any route takes (every body schema caps it here). */
export const PASSWORD_MAX = 1024;

/** The stable codes a client reads (HTTP 400 `{ error, code }`). */
export type PasswordProblemCode = 'password_too_short' | 'password_too_long' | 'password_common';

export type PasswordProblem = Readonly<{
  code: PasswordProblemCode;
  /** What the person reads. */
  message: string;
  /** The minimum length in force, for a client that shows it. */
  min: number;
}>;

/** The rule in force: the minimum length, and whether the common-password
 *  list is checked (only under a policy). */
export function passwordRule(): Readonly<{ min: number; commonList: boolean }> {
  const min = passwordPolicyMin();
  return min === null
    ? { min: DEFAULT_PASSWORD_MIN, commonList: false }
    : { min, commonList: true };
}

/** A common password: on the list, or a listed password or base word with
 *  only digits and symbols after it (`Welcome2026!`, `Qwertyuiop12`). */
export function isCommonPassword(password: string): boolean {
  const lower = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  const stripped = lower.replace(/[^a-z]+$/, '');
  return (
    stripped !== lower && (COMMON_PASSWORD_BASES.has(stripped) || COMMON_PASSWORDS.has(stripped))
  );
}

/** What is wrong with `password` as a new password, or null when it meets
 *  the rule in force. */
export function passwordProblem(password: string): PasswordProblem | null {
  const { min, commonList } = passwordRule();
  if (password.length < min) {
    return {
      code: 'password_too_short',
      message: `Password must be at least ${min} characters.`,
      min,
    };
  }
  if (password.length > PASSWORD_MAX) {
    return {
      code: 'password_too_long',
      message: `Password must be at most ${PASSWORD_MAX} characters.`,
      min,
    };
  }
  if (commonList && isCommonPassword(password)) {
    return {
      code: 'password_common',
      message: 'That password is too common. Choose a longer phrase that is not a known password.',
      min,
    };
  }
  return null;
}

/** The one 400 a route answers a password that does not meet the rule
 *  with: `{ error, code, min }`. */
export function passwordProblemBody(problem: PasswordProblem): {
  error: string;
  code: PasswordProblemCode;
  min: number;
} {
  return { error: problem.message, code: problem.code, min: problem.min };
}

/**
 * A sign-in took `password`: must the login change it before anything else?
 * Only under a policy (with none, never), when the password does not meet
 * the rule in force. The caller sets auth.users.must_change_password.
 */
export function signInNeedsPasswordChange(password: string): boolean {
  return passwordPolicyMin() !== null && passwordProblem(password) !== null;
}

/** A new password the rule refuses, thrown by the one hash (session.ts
 *  hashLoginPassword) when a writer did not check first: the caller hears
 *  400 and the coded body every route answers (passwordProblemBody). */
export class PasswordRuleError extends Error {
  readonly problem: PasswordProblem;
  constructor(problem: PasswordProblem) {
    super(problem.message);
    this.name = 'PasswordRuleError';
    this.problem = problem;
  }
}

defineDomainError(PasswordRuleError, {
  reason: 'the new password fails the password rule in force; the message says which part',
  status: 400,
  body: (e) => passwordProblemBody(e.problem),
});

/**
 * The box password rule's columns of auth.users (0347:
 * must_change_password, password_checked_min), to spread into a select of
 * the login row: only while MANTLE_POLICY_PASSWORD_MIN sets a rule. With
 * none, nothing: the select is the one from before the policy (and runs on
 * a database a migration behind).
 */
export function passwordRuleColumns(): {
  mustChangePassword?: typeof authUsers.mustChangePassword;
  passwordCheckedMin?: typeof authUsers.passwordCheckedMin;
} {
  return passwordPolicyMin() === null
    ? {}
    : {
        mustChangePassword: authUsers.mustChangePassword,
        passwordCheckedMin: authUsers.passwordCheckedMin,
      };
}
