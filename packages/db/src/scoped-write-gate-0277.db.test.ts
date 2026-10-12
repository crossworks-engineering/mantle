/**
 * Migration 0277 (workspaces arch A2b): the 0266 create and delete checks
 * wait for mantle.actor_check before they refuse a write on the write role
 * (mantle_write_user), and refuse as before everywhere else.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/scoped-write-gate-0277.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('0277: the scoped write gate', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;
  const notices: string[] = [];
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const member = `mantle_a2b_gate_${suffix}`;
  /** A login that only administers the write role (the ADMIN-only grant a
   *  CREATEROLE creator gets from Postgres 16): not a writer (audit M1). */
  const adminOnly = `mantle_a2b_gate_admin_${suffix}`;
  /** A per-database login's shape: SET only, no INHERIT. A writer. */
  const setOnly = `mantle_a2b_gate_set_${suffix}`;
  const owner = randomUUID();
  const folder = randomUUID();
  const ws = { admin: randomUUID(), other: randomUUID() };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, {
      max: 1,
      prepare: false,
      onnotice: (n) => notices.push(String(n.message ?? '')),
    });
    // The write role is one of the pool roles (A2b2a): the scratch database
    // set-up made it.
    // SET only, as the pool's per-database login: no committed role holds an
    // INHERIT membership in the write role (write-role.db.test.ts pins it,
    // cluster wide); the INHERIT case is its own cell, never committed.
    await sql.unsafe(`create role ${member} nologin`);
    await sql.unsafe(`grant mantle_write_user to ${member} with inherit false, set true`);
    await sql.unsafe(`create role ${adminOnly} nologin`);
    await sql.unsafe(
      `grant mantle_write_user to ${adminOnly} with admin option, inherit false, set false`,
    );
    await sql.unsafe(`create role ${setOnly} nologin`);
    await sql.unsafe(`grant mantle_write_user to ${setOnly} with inherit false, set true`);
    for (const r of [member, adminOnly, setOnly]) {
      await sql.unsafe(`grant execute on function mantle_scoped_write_refuses(text) to ${r}`);
    }
    await sql`insert into auth.users (id, email, password_hash, is_owner, role)
      values (${owner}, ${`${owner}@example.invalid`}, 'x', true, 'admin')`;
    await sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await sql`insert into workspaces (id, owner_id, name, is_admin) values
      (${ws.admin}, ${owner}, 'gate admin', true), (${ws.other}, ${owner}, 'gate other', false)`;
    await sql`insert into nodes (id, owner_id, type, title, path)
      values (${folder}, ${owner}, 'branch', 'gate folder', 'notes.gate')`;
    // No grant on the folder: no workspace may edit it.
  }, 120_000);

  afterAll(async () => {
    if (sql) {
      // The test's own roles; never the write role (a cluster object the
      // pool set-up owns).
      for (const r of [member, adminOnly, setOnly]) {
        await sql.unsafe(`drop owned by ${r}`).catch(() => {});
        await sql.unsafe(`drop role if exists ${r}`).catch(() => {});
      }
      await sql.end();
    }
    await scratch?.drop();
  });

  /** Run `q` in a transaction as `role` (or the pool's own superuser), the
   *  check at `mode` for it. */
  const asRole = async <T>(
    role: string | null,
    mode: 'off' | 'warn' | 'on',
    q: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> =>
    (await sql.begin(async (tx) => {
      if (mode !== 'off') await tx`select set_config('mantle.actor_check', ${mode}, true)`;
      if (role) await tx.unsafe(`set local session authorization ${role}`);
      return q(tx);
    })) as T;

  const refuses = (tx: postgres.TransactionSql) =>
    tx<{ r: boolean }[]>`select mantle_scoped_write_refuses('a test') as r`.then((x) => x[0]!.r);

  it('the system pool (a superuser) refuses as before, in every mode', async () => {
    for (const mode of ['off', 'warn', 'on'] as const) {
      expect(await asRole(null, mode, refuses), mode).toBe(true);
    }
  });

  it('the write role: off and warn let it run and report it (0278, L1), on refuses', async () => {
    for (const mode of ['off', 'warn'] as const) {
      notices.length = 0;
      expect(await asRole(member, mode, refuses), mode).toBe(false);
      expect(notices, mode).toEqual(['mantle actor miss: a test (refused when the check is on)']);
    }
    notices.length = 0;
    expect(await asRole(member, 'on', refuses)).toBe(true);
    expect(notices).toEqual([]);
  });

  it('an INHERIT membership counts as a writer too (made and rolled back in one transaction)', async () => {
    const inherit = `mantle_a2b_gate_inh_${suffix}`;
    let r: boolean | undefined;
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`create role ${inherit} nologin`);
        await tx.unsafe(`grant mantle_write_user to ${inherit} with inherit true, set false`);
        await tx.unsafe(
          `grant execute on function mantle_scoped_write_refuses(text) to ${inherit}`,
        );
        await tx.unsafe(`set local session authorization ${inherit}`);
        r = (await tx<{ r: boolean }[]>`select mantle_scoped_write_refuses('x') as r`)[0]!.r;
        throw new Error('rollback');
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== 'rollback') throw err;
      });
    expect(r).toBe(false);
  });

  it('only a SET or INHERIT membership counts, never an ADMIN-only one (audit M1)', async () => {
    expect(await asRole(adminOnly, 'off', refuses)).toBe(true);
    expect(await asRole(setOnly, 'off', refuses)).toBe(false);
    expect(await asRole(setOnly, 'on', refuses)).toBe(true);
  });

  it('a session cannot lower the box mode to skip the refusal', async () => {
    await sql`select mantle_set_actor_check('on')`;
    try {
      const fresh = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
      try {
        const r = await fresh.begin(async (tx) => {
          await tx`select set_config('mantle.actor_check', 'off', true)`;
          await tx.unsafe(`set local session authorization ${member}`);
          return (await tx<{ r: boolean }[]>`select mantle_scoped_write_refuses('x') as r`)[0]!.r;
        });
        expect(r).toBe(true);
      } finally {
        await fresh.end();
      }
    } finally {
      await sql`select mantle_set_actor_check('off')`;
    }
  });

  it('the 0266 create check still refuses a scoped write on the system pool', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('mantle.ws', ${`{${ws.other}}`}, true),
                        set_config('mantle.mod_ws', ${`{${ws.other}}`}, true)`;
        await tx`select mantle_lock_heads(array[${folder}]::uuid[], 'share')`;
        await tx`insert into nodes (owner_id, type, title, path)
          values (${owner}, 'note', 'gate note', 'notes.gate')`;
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
