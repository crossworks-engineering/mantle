/**
 * The box password policy (docs/policy.md): the one rule every new password
 * meets, the one hash that refuses a password the rule refuses, and the
 * sign-in that sets (or clears) the forced change. With no policy a new
 * password still meets the new-password rule (8 characters, 72 bytes, three
 * kinds below a 20-character passphrase, the common list), and a sign-in
 * writes nothing.
 * The login row is stood in; bcrypt is real.
 */
import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBoxPolicyForTests } from '@mantle/config';

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = () => chain;
  chain.limit = async () => h.rows;
  chain.update = () => ({
    set: (v: Record<string, unknown>) => {
      h.updates.push(v);
      return { where: async () => [] };
    },
  });
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    db: chain,
    onFullSystemRoute: (_spot: string, fn: () => unknown) => fn(),
  };
});

import {
  updatePassword,
  authenticatePassword,
  hashLoginPassword,
  notePasswordSet,
  verifyPasswordForUse,
} from './session';
import {
  isCommonPassword,
  passwordKinds,
  passwordProblem,
  passwordRule,
  PasswordRuleError,
  signInNeedsPasswordChange,
} from './password-rule';

const saved = process.env.MANTLE_POLICY_PASSWORD_MIN;
function policyMin(v: string | undefined): void {
  if (v === undefined) delete process.env.MANTLE_POLICY_PASSWORD_MIN;
  else process.env.MANTLE_POLICY_PASSWORD_MIN = v;
  resetBoxPolicyForTests();
}

beforeEach(() => policyMin(undefined));
afterEach(() => {
  policyMin(saved);
  h.rows = [];
  h.updates = [];
});

const row = (password: string, over: Record<string, unknown> = {}) => ({
  id: 'l1',
  email: 'pat@example.invalid',
  hash: bcrypt.hashSync(password, 4),
  role: 'member',
  disabledAt: null,
  sessionEpoch: 2,
  mustChangePassword: false,
  passwordCheckedMin: null,
  ...over,
});

const RULE = { min: 8, maxBytes: 72, kinds: 3, passphrase: 20, commonList: true };

describe('no policy: the new-password rule', () => {
  it('8 characters, three kinds below a 20-character passphrase, not common', () => {
    expect(passwordRule()).toEqual(RULE);
    expect(passwordProblem('Ket-un7')?.code).toBe('password_too_short');
    expect(passwordProblem('Ket-und7')).toBeNull();
    expect(passwordProblem('Kettle-under-7')).toBeNull();
    // Eight characters still need three kinds.
    expect(passwordProblem('kettle77')?.code).toBe('password_weak');
    // Two kinds: small letters and digits, or small letters and spaces.
    expect(passwordProblem('kettleunder7')?.code).toBe('password_weak');
    expect(passwordProblem('kettle under stairs')?.code).toBe('password_weak');
    // A passphrase of 20 characters or more needs no mix.
    expect(passwordProblem('kettle under the stairs')).toBeNull();
    expect(passwordProblem('Password1234')?.code).toBe('password_common');
    expect(passwordProblem('passwor')?.code).toBe('password_too_short');
    expect(passwordProblem('password')?.code).toBe('password_weak');
    expect(passwordProblem('Password1')?.code).toBe('password_common');
    expect(signInNeedsPasswordChange('password')).toBe(false);
  });

  it('at most 72 bytes, counted in UTF-8', () => {
    expect(passwordProblem(`Aa1!${'x'.repeat(68)}`)).toBeNull();
    expect(passwordProblem(`Aa1!${'x'.repeat(69)}`)?.code).toBe('password_too_long');
    // é takes two bytes: 38 characters, 74 bytes.
    expect(passwordProblem(`Aa1!${'é'.repeat(34)}`)).toBeNull();
    expect(passwordProblem(`Aa1!${'é'.repeat(35)}`)?.code).toBe('password_too_long');
    // An emoji is one character to a person and two to length: counted once.
    expect(passwordProblem(`🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑`)?.code).toBe('password_weak');
  });

  it('the kinds of any script', () => {
    expect(passwordKinds('abc')).toBe(1);
    expect(passwordKinds('aB')).toBe(2);
    expect(passwordKinds('aB3')).toBe(3);
    expect(passwordKinds('aB3 ')).toBe(4);
    expect(passwordKinds('Привет7')).toBe(3);
    expect(passwordKinds('日本語のパス')).toBe(1);
    expect(passwordKinds('日本語のパス7!')).toBe(3);
    // Invisible characters are no symbol.
    expect(passwordKinds('kettleunder7\u0000')).toBe(2);
    expect(passwordKinds('kettleunder7\u200b')).toBe(2);
    expect(passwordKinds('kettleunder7\u0301')).toBe(2);
    expect(passwordProblem('kettleunder7\u200b')?.code).toBe('password_weak');
  });

  it('the one hash takes a password that meets the rule, and refuses one that does not', async () => {
    await expect(hashLoginPassword('Kettle-under-7')).resolves.toMatch(/^\$2[aby]\$12\$/);
    await expect(hashLoginPassword('short')).rejects.toBeInstanceOf(PasswordRuleError);
  });

  it('a sign-in writes nothing', async () => {
    h.rows = [row('password')];
    expect(await authenticatePassword('pat@example.invalid', 'password')).toEqual({
      id: 'l1',
      sessionEpoch: 2,
    });
    // Not even a flag left set before: with no rule it is never read or written.
    h.rows = [row('password', { mustChangePassword: true })];
    await authenticatePassword('pat@example.invalid', 'password');
    await notePasswordSet('l1');
    expect(await verifyPasswordForUse('l1', 'password')).toBe('ok');
    expect(h.updates).toEqual([]);
  });
});

describe('a new password records the rule it was set under', () => {
  it('none with no rule, so a rule that comes back checks it', async () => {
    await updatePassword('l1', 'Kettle-under-7');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ mustChangePassword: false, passwordCheckedMin: null });
  });

  it('the minimum under a rule', async () => {
    policyMin('12');
    await updatePassword('l1', 'blue kettle under the stairs');
    expect(h.updates[0]).toMatchObject({ mustChangePassword: false, passwordCheckedMin: 12 });
  });
});

describe('a policy minimum', () => {
  it('raises the minimum, never lowers it under 8', () => {
    policyMin('16');
    expect(passwordRule().min).toBe(16);
    expect(passwordProblem('Kettle-under-7')?.code).toBe('password_too_short');
    policyMin('6');
    expect(passwordRule().min).toBe(8);
  });

  it('a sign-in asks for a change on the policy minimum and the list only', () => {
    policyMin('12');
    // Set before the new rule: two kinds, or past 72 bytes. Not held.
    expect(signInNeedsPasswordChange('kettleunder7')).toBe(false);
    expect(signInNeedsPasswordChange(`Aa1!${'x'.repeat(80)}`)).toBe(false);
    expect(signInNeedsPasswordChange('kettle7')).toBe(true);
    expect(signInNeedsPasswordChange('Password1234')).toBe(true);
  });
});

describe('MANTLE_POLICY_PASSWORD_MIN=12', () => {
  beforeEach(() => policyMin('12'));

  it('length, then the common list', () => {
    expect(passwordRule()).toEqual({ ...RULE, min: 12 });
    expect(passwordProblem('abcdefghijk')?.code).toBe('password_too_short');
    expect(passwordProblem('Password1234')?.code).toBe('password_common');
    expect(passwordProblem('Welcome2026!!')?.code).toBe('password_common');
    expect(passwordProblem('Qwertyuiop12')?.code).toBe('password_common');
    expect(passwordProblem('blue kettle under the stairs')).toBeNull();
    // A passphrase needs no mix: letters only is fine when long and uncommon.
    expect(passwordProblem('correcthorsebatterystaple')).toBeNull();
    expect(isCommonPassword('Summer2025')).toBe(true);
  });

  it('runs, repeats and few characters are common at any length (audit round 6)', () => {
    for (const weak of [
      '123456789012',
      '111111111111',
      '000000000000',
      '1234567890ab',
      ' '.repeat(12),
      'abababababab',
      'abcdefghijkl',
      '0987654321zz',
      '2026Welcome!',
      'qwertyuiop12',
      'October2026!',
      'Monday2026!!',
      'passwordpassword',
      'welcomewelcome',
      // Audit round 8: spaces and digits between, digits for letters.
      'welcome welcome',
      'Summer Summer 2026',
      'Welcome1Welcome1',
      'Password1!Password1!',
      'password2026password',
      'P@$$w0rd2026!',
      'P4ssw0rd2026',
      'Adm1n2026!!!',
      'Letme1n2026!',
      '1q2w3e4r5t6y7u',
      '1qaz2wsx3edc4rfv',
    ]) {
      expect(isCommonPassword(weak), weak).toBe(true);
    }
    // A long random string of digits is not a run, and the pairs and threes
    // inside ordinary words (tre, st, def) are not either (audit round 7).
    for (const good of [
      '839201746385',
      'Tuesday rain on the 7th floor',
      'Tutors stress tests',
      'a red deer feeds',
      'deer feed reeds',
      'Ted fed red deer',
      'tutor stutters',
      'tree free reed',
      'street trees',
      'redder trees',
      // Any script's letters are letters; many digits around a word are not
      // decoration.
      'Привет как дела hello',
      '8472-9931-5520-test',
    ]) {
      expect(isCommonPassword(good), good).toBe(false);
    }
  });

  it('the one hash refuses a password the rule refuses, with its code', async () => {
    const err = await hashLoginPassword('Password1234').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasswordRuleError);
    expect((err as PasswordRuleError).problem.code).toBe('password_common');
  });

  it('a sign-in with a weak password sets the flag, a good one clears it', async () => {
    h.rows = [row('password1234')];
    expect(await authenticatePassword('pat@example.invalid', 'password1234')).not.toBeNull();
    expect(h.updates).toEqual([{ mustChangePassword: true, passwordCheckedMin: 12 }]);
    h.updates = [];
    h.rows = [
      row('blue kettle under the stairs', { mustChangePassword: true, passwordCheckedMin: 12 }),
    ];
    await authenticatePassword('pat@example.invalid', 'blue kettle under the stairs');
    expect(h.updates).toEqual([{ mustChangePassword: false, passwordCheckedMin: 12 }]);
    // Checked under a lower minimum: recorded under this one.
    h.updates = [];
    h.rows = [row('blue kettle under the stairs', { passwordCheckedMin: 8 })];
    await authenticatePassword('pat@example.invalid', 'blue kettle under the stairs');
    expect(h.updates).toEqual([{ mustChangePassword: false, passwordCheckedMin: 12 }]);
    // Already right: no write.
    h.updates = [];
    h.rows = [row('blue kettle under the stairs', { passwordCheckedMin: 12 })];
    await authenticatePassword('pat@example.invalid', 'blue kettle under the stairs');
    expect(h.updates).toEqual([]);
  });

  it('a password prompt checks the password too, and grants nothing on a weak one', async () => {
    h.rows = [row('password1234')];
    expect(await verifyPasswordForUse('l1', 'password1234')).toBe('held');
    expect(h.updates).toEqual([{ mustChangePassword: true, passwordCheckedMin: 12 }]);
    h.updates = [];
    h.rows = [row('blue kettle under the stairs')];
    expect(await verifyPasswordForUse('l1', 'blue kettle under the stairs')).toBe('ok');
    expect(await verifyPasswordForUse('l1', 'not it at all')).toBe('wrong');
  });

  it('a new login is recorded as checked under the rule', async () => {
    await notePasswordSet('l1');
    expect(h.updates).toEqual([{ mustChangePassword: false, passwordCheckedMin: 12 }]);
  });

  it('a wrong password writes nothing', async () => {
    h.rows = [row('password1234')];
    expect(await authenticatePassword('pat@example.invalid', 'password12345')).toBeNull();
    expect(h.updates).toEqual([]);
  });
});
