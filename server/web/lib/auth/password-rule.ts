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

/** Runs a person types without thinking: counting (round past 9), the
 *  alphabet, the keyboard rows. A run reads one way along one of these, or
 *  the other way along it reversed. */
const SEQUENCES = [
  '0123456789'.repeat(2) + '0',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  '!@#$%^&*()',
].flatMap((seq) => [seq, [...seq].reverse().join('')]);

/** The shortest sequential run taken out: 4, so the pairs and threes inside
 *  ordinary words (`tre` in `street`, `def` in `defer`) are left alone. */
const MIN_SEQUENCE_RUN = 4;
/** The shortest repeat taken out (`111`, `aaa`). */
const MIN_REPEAT_RUN = 3;

/** How long the run at `s[i]` is: the longer of a repeat of one character and
 *  a stretch that reads along one sequence in one direction; 0 under the
 *  minimums. */
function runAt(s: string, i: number): number {
  let repeat = 1;
  while (s.charAt(i + repeat) !== '' && s.charAt(i + repeat) === s.charAt(i)) repeat++;
  let along = 0;
  for (const seq of SEQUENCES) {
    let len = 0;
    while (i + len < s.length && seq.includes(s.slice(i, i + len + 1))) len++;
    along = Math.max(along, len);
  }
  return Math.max(repeat >= MIN_REPEAT_RUN ? repeat : 0, along >= MIN_SEQUENCE_RUN ? along : 0);
}

/** `lower` with its repeated and sequential runs (`111`, `1234567890`,
 *  `qwerty`, `dcba`) and all white space taken out. */
function withoutRuns(lower: string): string {
  const s = lower.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i < s.length;) {
    const run = runAt(s, i);
    if (run > 0) {
      i += run;
    } else {
      out += s.charAt(i);
      i++;
    }
  }
  return out;
}

/** A common password: on the list; a listed password or base word with only
 *  digits and symbols before or after it (`Welcome2026!`, `2026welcome`),
 *  or said twice or more (`welcomewelcome`);
 *  fewer than 4 different characters (`abababababab`); or, with its repeated
 *  and sequential runs taken out, fewer than 4 characters left
 *  (`123456789012`, `1234567890ab`, `Qwertyuiop12`, 12 spaces). */
export function isCommonPassword(password: string): boolean {
  const lower = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  if (new Set(lower.replace(/\s+/g, '')).size < 4) return true;
  if (withoutRuns(lower).length < 4) return true;
  const stripped = lower.replace(/^[^a-z]+/, '').replace(/[^a-z]+$/, '');
  // One listed word said twice or more (`passwordpassword`).
  const unit = /^(.+?)\1+$/.exec(stripped)?.[1];
  if (unit !== undefined && (COMMON_PASSWORD_BASES.has(unit) || COMMON_PASSWORDS.has(unit))) {
    return true;
  }
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
 * none, nothing: the select is the one from before the policy. (The
 * password writers set both columns always, so a box runs on 0347.)
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
