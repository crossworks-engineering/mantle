/**
 * The Users screen's role change as Admin membership (plan v3.2 S8b round
 * 4, L2 and L3), with a stand-in transaction (no database):
 *  - a concurrent change that got there first (the definer's "not a user"
 *    on a second demotion, "already a user" on a second promotion) is a
 *    no-op inside a savepoint, not the end of the change;
 *  - any other refusal is thrown on (the savepoint is not released);
 *  - nothing runs when membership already says what the change asks;
 *  - adminMembershipRefusal: the last Moderator is the 409 last-admin, a
 *    caller the definer refuses (no users area, any 42501 mantle_ws
 *    refusal, the caller's not_found, no_acting_login, read_only) a 403,
 *    anything else null.
 */
import { describe, expect, it, vi } from 'vitest';
import { adminMembershipChange, adminMembershipRefusal, type LoginTx } from './login-update';

/** A stand-in transaction: the Admin lookup answers `member`, the definer
 *  call throws `definerError` when given; every statement's text is kept. */
function standIn(member: boolean, definerError?: Error) {
  const ran: string[] = [];
  const tx = {
    execute: async (q: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(q.queryChunks ?? q);
      ran.push(text);
      if (text.includes('is_admin')) return [{ owner: 'o', ws: 'w', member }];
      if (text.includes('mantle_ws_') && definerError) throw definerError;
      return [];
    },
    // drizzle's nested transaction: a savepoint, rolled back on a throw.
    transaction: async (fn: (sp: unknown) => Promise<unknown>) => {
      ran.push('savepoint');
      try {
        const out = await fn(tx);
        ran.push('release savepoint');
        return out;
      } catch (err) {
        ran.push('rollback to savepoint');
        throw err;
      }
    },
  };
  return { tx: tx as unknown as LoginTx, ran };
}

const step = (ran: string[]) =>
  ran.map((t) =>
    t.includes('is_admin')
      ? 'lookup'
      : t.includes('mantle_ws_add_user')
        ? 'add'
        : t.includes('mantle_ws_remove_user')
          ? 'remove'
          : t.includes('rollback to savepoint')
            ? 'rollback'
            : t.includes('release savepoint')
              ? 'release'
              : t.includes('savepoint')
                ? 'savepoint'
                : t,
  );

describe('adminMembershipChange', () => {
  it('a second demotion that lost the race is a no-op (the definer`s not_user)', async () => {
    const { tx, ran } = standIn(
      true,
      new Error('mantle_ws:not_user mantle_ws_remove_user: not a user of the workspace'),
    );
    await expect(adminMembershipChange(tx, 'login', false)).resolves.toBeUndefined();
    expect(step(ran)).toEqual(['lookup', 'savepoint', 'remove', 'rollback']);
  });

  it('a second promotion that lost the race is a no-op (the definer`s already_user)', async () => {
    const { tx, ran } = standIn(
      false,
      new Error('mantle_ws:already_user mantle_ws_add_user: already a user of the workspace'),
    );
    await expect(adminMembershipChange(tx, 'login', true)).resolves.toBeUndefined();
    expect(step(ran)).toEqual(['lookup', 'savepoint', 'add', 'rollback']);
  });

  it('any other refusal is thrown on', async () => {
    const refusal = new Error(
      'mantle_ws:admin_users_only mantle_ws_remove_user: who is an Admin user needs the users area',
    );
    const { tx, ran } = standIn(true, refusal);
    await expect(adminMembershipChange(tx, 'login', false)).rejects.toBe(refusal);
    expect(step(ran)).toEqual(['lookup', 'savepoint', 'remove', 'rollback']);
    // The race's other code on the other direction is a refusal too.
    const wrong = standIn(false, new Error('mantle_ws:not_user mantle_ws_add_user: x'));
    await expect(adminMembershipChange(wrong.tx, 'login', true)).rejects.toThrow(/not_user/);
  });

  it('runs nothing when membership already says it', async () => {
    for (const toAdmin of [true, false]) {
      const { tx, ran } = standIn(toAdmin);
      await adminMembershipChange(tx, 'login', toAdmin);
      expect(step(ran)).toEqual(['lookup']);
    }
  });
});

describe('adminMembershipRefusal', () => {
  const pg = (message: string) => ({ message: 'wrapped', cause: { message } });

  it('maps the definer`s refusals', () => {
    expect(adminMembershipRefusal(pg('mantle_ws:last_moderator mantle_ws_remove_user: x'))).toEqual(
      expect.objectContaining({ status: 409, reason: 'last-admin' }),
    );
    for (const code of ['admin_users_only', 'admin_only', 'forbidden']) {
      expect(adminMembershipRefusal(pg(`mantle_ws:${code} mantle_ws_add_user: x`)), code).toEqual(
        expect.objectContaining({ status: 403, reason: 'users-area' }),
      );
    }
    expect(adminMembershipRefusal(pg('mantle_ws:archived mantle_ws_add_user: x'))).toBeNull();
    expect(adminMembershipRefusal(new Error('connection lost'))).toBeNull();
  });

  it('any 42501 mantle_ws refusal, and the caller`s not_found, no_acting_login and read_only, is a 403 (r6 app L1)', () => {
    const pgc = (message: string, code: string) => ({
      message: 'wrapped',
      cause: { message, code },
    });
    for (const code of ['not_found', 'no_acting_login', 'read_only']) {
      expect(adminMembershipRefusal(pg(`mantle_ws:${code} mantle_ws_add_user: x`)), code).toEqual(
        expect.objectContaining({ status: 403, reason: 'forbidden' }),
      );
    }
    for (const code of ['owner_stays_admin', 'self_demote', 'something_new']) {
      expect(
        adminMembershipRefusal(pgc(`mantle_ws:${code} mantle_ws_remove_user: x`, '42501')),
        code,
      ).toEqual(expect.objectContaining({ status: 403 }));
    }
    // A target's refusal is not the caller's: no 403 by name alone.
    for (const code of ['user_not_found', 'not_user', 'already_user']) {
      expect(
        adminMembershipRefusal(pgc(`mantle_ws:${code} mantle_ws_add_user: x`, 'P0002')),
        code,
      ).toBeNull();
    }
    // A 42501 that is no definer refusal (a permission error) is not mapped.
    expect(adminMembershipRefusal(pgc('permission denied for table users', '42501'))).toBeNull();
  });

  it('says no_acting_login and not_found in the log by code, the other 403s not (r7 app LOW-1)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const code of ['no_acting_login', 'not_found']) {
        warn.mockClear();
        expect(adminMembershipRefusal(pg(`mantle_ws:${code} mantle_ws_add_user: x`))?.status).toBe(
          403,
        );
        expect(warn, code).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0]), code).toContain(`mantle_ws:${code}`);
      }
      warn.mockClear();
      for (const code of ['read_only', 'forbidden', 'last_moderator']) {
        adminMembershipRefusal(pg(`mantle_ws:${code} mantle_ws_add_user: x`));
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
