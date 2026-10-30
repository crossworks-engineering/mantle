/**
 * The box password policy (docs/policy.md): the one rule every new password
 * meets, the one hash that refuses a password the rule refuses, and the
 * sign-in that sets (or clears) the forced change. With no policy the rule
 * is today's, exactly: 8 characters, no list, and a sign-in writes nothing.
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

import { authenticatePassword, hashLoginPassword } from './session';
import {
  isCommonPassword,
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
  ...over,
});

describe("no policy: today's rule, exactly", () => {
  it('8 characters, no list', () => {
    expect(passwordRule()).toEqual({ min: 8, commonList: false });
    expect(passwordProblem('1234567')?.code).toBe('password_too_short');
    // A common password of 8+ characters passes: no list without a policy.
    expect(passwordProblem('password')).toBeNull();
    expect(passwordProblem('12345678')).toBeNull();
    expect(passwordProblem('x'.repeat(1024))).toBeNull();
    expect(passwordProblem('x'.repeat(1025))?.code).toBe('password_too_long');
    expect(signInNeedsPasswordChange('password')).toBe(false);
  });

  it('the one hash takes what it took before', async () => {
    await expect(hashLoginPassword('password')).resolves.toMatch(/^\$2[aby]\$12\$/);
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
    expect(h.updates).toEqual([]);
  });
});

describe('MANTLE_POLICY_PASSWORD_MIN=12', () => {
  beforeEach(() => policyMin('12'));

  it('length, then the common list', () => {
    expect(passwordRule()).toEqual({ min: 12, commonList: true });
    expect(passwordProblem('abcdefghijk')?.code).toBe('password_too_short');
    expect(passwordProblem('password1234')?.code).toBe('password_common');
    expect(passwordProblem('Welcome2026!!')?.code).toBe('password_common');
    expect(passwordProblem('Qwertyuiop12')?.code).toBe('password_common');
    expect(passwordProblem('blue kettle under the stairs')).toBeNull();
    // No symbol rule: letters only is fine when long and uncommon.
    expect(passwordProblem('correcthorsebatterystaple')).toBeNull();
    expect(isCommonPassword('Summer2025')).toBe(true);
  });

  it('the one hash refuses a password the rule refuses, with its code', async () => {
    const err = await hashLoginPassword('password1234').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasswordRuleError);
    expect((err as PasswordRuleError).problem.code).toBe('password_common');
  });

  it('a sign-in with a weak password sets the flag, a good one clears it', async () => {
    h.rows = [row('password1234')];
    expect(await authenticatePassword('pat@example.invalid', 'password1234')).not.toBeNull();
    expect(h.updates).toEqual([{ mustChangePassword: true }]);
    h.updates = [];
    h.rows = [row('blue kettle under the stairs', { mustChangePassword: true })];
    await authenticatePassword('pat@example.invalid', 'blue kettle under the stairs');
    expect(h.updates).toEqual([{ mustChangePassword: false }]);
    // Already right: no write.
    h.updates = [];
    h.rows = [row('blue kettle under the stairs')];
    await authenticatePassword('pat@example.invalid', 'blue kettle under the stairs');
    expect(h.updates).toEqual([]);
  });

  it('a wrong password writes nothing', async () => {
    h.rows = [row('password1234')];
    expect(await authenticatePassword('pat@example.invalid', 'password12345')).toBeNull();
    expect(h.updates).toEqual([]);
  });
});
