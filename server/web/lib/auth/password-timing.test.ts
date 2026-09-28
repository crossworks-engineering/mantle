/**
 * A password login costs one bcrypt compare whether or not the email has an
 * account (final audit F31: an unknown email answered about 250 ms sooner,
 * which told anyone which emails have logins). The login row is stood in;
 * bcrypt is real, only watched.
 */
import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('@mantle/db', async (importOriginal) => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = () => chain;
  chain.limit = async () => h.rows;
  return { ...(await importOriginal<Record<string, unknown>>()), db: chain };
});

import { authenticatePassword, loginWithPassword } from './session';

let compare: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  compare = vi.spyOn(bcrypt, 'compare');
});
afterEach(() => {
  compare.mockRestore();
  h.rows = [];
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  email: 'pat@example.invalid',
  hash: bcrypt.hashSync('right password', 4),
  role: 'member',
  disabledAt: null,
  sessionEpoch: 2,
  ...over,
});

describe('password login timing', () => {
  it('runs bcrypt against a cost-12 dummy hash for an unknown email', async () => {
    h.rows = [];
    expect(await loginWithPassword('nobody@example.invalid', 'whatever')).toBeNull();
    expect(compare).toHaveBeenCalledTimes(1);
    const hash = String(compare.mock.calls[0]![1]);
    // The same cost as every stored login (hashLoginPassword), so the same time.
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(bcrypt.getRounds(hash)).toBe(12);
  });

  it('runs bcrypt once for a disabled login and a wrong password too', async () => {
    h.rows = [row({ disabledAt: new Date() })];
    expect(await loginWithPassword('pat@example.invalid', 'right password')).toBeNull();
    h.rows = [row()];
    expect(await loginWithPassword('pat@example.invalid', 'wrong password')).toBeNull();
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it('answers a good password with the login and its session epoch', async () => {
    h.rows = [row()];
    expect(await authenticatePassword('pat@example.invalid', 'right password')).toEqual({
      id: 'l1',
      sessionEpoch: 2,
    });
  });
});
