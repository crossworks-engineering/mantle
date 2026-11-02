/**
 * THE password rule: one function for every password a login is given (a
 * signup, the first owner, an invite accept, an Admin's new login or reset,
 * a login's own change, the onboard script), and the one place a sign-in
 * asks whether the password it just took still meets the rule.
 *
 * Every new password (2026-11-02): at least 12 characters (or the box
 * policy's minimum, if higher), at most 72 bytes (all bcrypt reads), three
 * of the four kinds (small letters, capitals, digits, symbols) unless it is a
 * passphrase of 20 characters or more, and not a common password (a bundled
 * list, no outside call). A password set before keeps working: a sign-in
 * never refuses one, and only a box policy can ask for a change at sign-in,
 * on its own minimum and the common list (plan "Corporate sign-in", section
 * 6.4). docs/policy.md.
 *
 * Company sign-in: a login whose password is no way in (required mode, a
 * linked login) is outside this rule. Its password is not checked at a
 * sign-in or a prompt (session.ts notePasswordChecked), and no hold reaches
 * its credentials (lib/oidc/hold.ts credentialPasswordHold).
 */
import { DEFAULT_PASSWORD_MIN, passwordPolicyMin } from '@mantle/config';

import { authUsers } from '@mantle/db';
import { defineDomainError } from '@mantle/std';
import { COMMON_PASSWORD_BASES, COMMON_PASSWORDS } from './common-passwords';

/** The longest password any route takes (every body schema caps it here):
 *  a sign-in must still take a long one set before the 72-byte cap. */
export const PASSWORD_MAX = 1024;

/** The fewest characters of a new password with no box policy. */
export const NEW_PASSWORD_MIN = 12;
/** The most UTF-8 bytes of a new password: bcrypt reads no more, so a longer
 *  one would promise more than the hash keeps. */
export const NEW_PASSWORD_MAX_BYTES = 72;
/** How many of the four kinds (small letters, capitals, digits, symbols) a
 *  new password must use. */
export const NEW_PASSWORD_KINDS = 3;
/** From this many characters a passphrase needs no mix of kinds. */
export const PASSPHRASE_MIN = 20;

/** The stable codes a client reads (HTTP 400 `{ error, code }`). */
export type PasswordProblemCode =
  'password_too_short' | 'password_too_long' | 'password_weak' | 'password_common';

export type PasswordProblem = Readonly<{
  code: PasswordProblemCode;
  /** What the person reads. */
  message: string;
  /** The minimum length in force, for a client that shows it. */
  min: number;
}>;

/** The rule a new password must meet, as a client shows it. */
export type NewPasswordRule = Readonly<{
  /** Fewest characters. */
  min: number;
  /** Most UTF-8 bytes. */
  maxBytes: number;
  /** Kinds of character needed, below `passphrase` characters. */
  kinds: number;
  /** From this many characters, any mix of kinds. */
  passphrase: number;
  /** A common password is refused (always). */
  commonList: true;
}>;

/** The rule in force for a new password. */
export function passwordRule(): NewPasswordRule {
  return {
    min: Math.max(NEW_PASSWORD_MIN, passwordPolicyMin() ?? DEFAULT_PASSWORD_MIN),
    maxBytes: NEW_PASSWORD_MAX_BYTES,
    kinds: NEW_PASSWORD_KINDS,
    passphrase: PASSPHRASE_MIN,
    commonList: true,
  };
}

/** Which of the four kinds `password` uses: small letters (and letters of a
 *  script with no capitals), capitals, digits, and anything else (symbols,
 *  spaces, punctuation). */
export function passwordKinds(password: string): number {
  // Symbols: anything a person sees that is no letter or digit. A control
  // or format character (NUL, a zero-width space) or a lone combining mark
  // is not one: it would make a password pass while adding nothing to read.
  const kinds = [/[\p{Ll}\p{Lo}\p{Lm}]/u, /[\p{Lu}\p{Lt}]/u, /\p{N}/u, /[^\p{L}\p{N}\p{M}\p{C}]/u];
  return kinds.filter((k) => k.test(password)).length;
}

/** Runs a person types without thinking: counting (round past 9), the
 *  alphabet, the keyboard rows and columns. A run reads one way along one of
 *  these, or the other way along it reversed. */
const SEQUENCES = [
  '0123456789'.repeat(2) + '0',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  '!@#$%^&*()',
  '1q2w3e4r5t6y7u8i9o0p',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p',
  'qazwsxedcrfvtgbyhnujmikolp',
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

/** Digits and symbols written for the letters they look like. */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  '@': 'a',
  '4': 'a',
  $: 's',
  '5': 's',
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '7': 't',
};

/** The most digits and symbols a password may carry around or between
 *  listed words and still be read as those words (`Password1!Password1!`
 *  is; `8472-9931-5520-test` is not). */
const MAX_DECORATION = 8;

/** `word` is a listed password or base word, or one said twice or more. */
function isListedWord(word: string): boolean {
  const unit = /^(.+?)\1+$/u.exec(word)?.[1] ?? word;
  return (
    COMMON_PASSWORD_BASES.has(word) ||
    COMMON_PASSWORDS.has(word) ||
    COMMON_PASSWORD_BASES.has(unit) ||
    COMMON_PASSWORDS.has(unit)
  );
}

/** A common password: on the list; fewer than 4 different characters
 *  (`abababababab`); with its repeated and sequential runs taken out, fewer
 *  than 4 characters left (`123456789012`, `1234567890ab`, `Qwertyuiop12`,
 *  12 spaces); or a listed password or base word (also with digits for
 *  letters, `P@$$w0rd`) said once or more with a few digits and symbols
 *  around or between (`Welcome2026!`, `2026welcome`, `welcome welcome`,
 *  `Welcome1Welcome1`). Letters are any script's: a passphrase in Cyrillic
 *  or Greek is read as letters. */
export function isCommonPassword(password: string): boolean {
  const lower = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  const compact = lower.replace(/\s+/g, '');
  if (new Set(compact).size < 4) return true;
  if (withoutRuns(lower).length < 4) return true;
  const letters = compact.replace(/[^\p{L}]+/gu, '');
  if (compact.length - letters.length <= MAX_DECORATION && isListedWord(letters)) return true;
  const ends = compact.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
  if (compact.length - ends.length > MAX_DECORATION) return false;
  return isListedWord([...ends].map((c) => LOOK_ALIKES[c] ?? c).join(''));
}

/** What is wrong with `password` as a new password, or null when it meets
 *  the rule in force. */
export function passwordProblem(password: string): PasswordProblem | null {
  const rule = passwordRule();
  const { min } = rule;
  const chars = [...password].length;
  if (chars < min) {
    return {
      code: 'password_too_short',
      message: `Password must be at least ${min} characters.`,
      min,
    };
  }
  if (Buffer.byteLength(password, 'utf8') > rule.maxBytes) {
    return {
      code: 'password_too_long',
      message: `Password must be at most ${rule.maxBytes} bytes (${rule.maxBytes} plain letters; accented letters and emoji take more).`,
      min,
    };
  }
  if (chars < rule.passphrase && passwordKinds(password) < rule.kinds) {
    return {
      code: 'password_weak',
      message: `Use at least ${rule.kinds} of: small letters, capitals, digits, symbols. Or use a passphrase of ${rule.passphrase} characters or more.`,
      min,
    };
  }
  if (isCommonPassword(password)) {
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
 * Only under a policy (with none, never), when the password is shorter than
 * the policy's minimum or common. The parts of the new-password rule a
 * policy does not name (the 72-byte cap, the mix of kinds, the 12 floor)
 * hold no login that set its password before them. The caller sets
 * auth.users.must_change_password.
 */
export function signInNeedsPasswordChange(password: string): boolean {
  const min = passwordPolicyMin();
  // UTF-16 units, as the rule counted when these passwords were set: a
  // password of emoji that met the minimum then is not held now.
  return min !== null && (password.length < min || isCommonPassword(password));
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
 * The box password rule's columns of auth.users (0348:
 * must_change_password, password_checked_min), to spread into a select of
 * the login row: only while MANTLE_POLICY_PASSWORD_MIN sets a rule. With
 * none, nothing: the select is the one from before the policy. (The
 * password writers set both columns always, so a box runs on 0348.)
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
