/**
 * Nested system transactions and the heads (workspaces arch A2b, plan 20.2),
 * on a real, migrated Postgres with mantle.heads_check = 'on' for the box:
 *  - a nested withSystemTx is a savepoint of the outer transaction: an
 *    inner error rolls back the inner writes only and runs the inner
 *    rollback hooks; on success the inner hooks follow the outer outcome;
 *    a second nested call at the same time, or one after the outer ended,
 *    is refused (A2b1 audit, M2);
 *  - a nested withHeads takes more heads (mantle_lock_heads_nested), never
 *    a second first lock; the database refuses a nested subtree lock;
 *  - withDeadlockRetry inside an open transaction runs once: the outermost
 *    call retries;
 *  - a nested call with another actor or create home is refused;
 *  - withHeads works under every actor kind (the actor SET takes no
 *    transaction id, so the heads stay the first lock);
 *  - more than 32 nested calls in one transaction warn once (A2b1 fix
 *    round 2, L2);
 *  - a first heads lock in a savepoint that rolls back leaves the
 *    transaction id taken: a later first lock is refused (fix round 2, L3,
 *    a known limit in docs/actors.md).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/a2b-nested-tx.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql as sqlTag } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';
import type { Actor } from './actor';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('nested system transactions (arch A2b, plan 20.2)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  const owner = randomUUID();
  const folder = randomUUID();
  const sub = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  type Tx = Parameters<Parameters<typeof import('./index').withSystemTx>[0]>[0];
  const one = async <T>(tx: Tx, q: ReturnType<typeof sqlTag>) =>
    ((await tx.execute(q)) as unknown as T[])[0]!;
  const held = async (tx: Tx) =>
    [...(await one<{ h: string[] }>(tx, sqlTag`select mantle_heads_held() as h`)).h].sort();
  const misses = async () =>
    (await sql<{ n: number }[]>`select count(*)::int as n from heads_check_misses`)[0]!.n;

  beforeAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, is_owner, role)
      values (${owner}, ${`${owner}@example.invalid`}, 'x', true, 'admin')`;
    await sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await sql`insert into nodes (id, owner_id, type, title, path) values
      (${folder}, ${owner}, 'branch', 'a2b folder', 'notes.a2b'),
      (${sub}, ${owner}, 'branch', 'a2b sub', 'notes.a2b.sub'),
      (${a}, ${owner}, 'note', 'a2b a', 'notes.a2b'),
      (${b}, ${owner}, 'note', 'a2b b', 'notes.a2b.sub')`;
    // The box is strict from here: a heads lock that is not the first lock
    // fails, and so does a write without heads (new connections only).
    await sql.unsafe(`alter database "${scratch.name}" set mantle.heads_check = 'on'`);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
  }, 120_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  it('the box runs the heads check on', async () => {
    const r = await m.withSystemTx((tx) =>
      one<{ m: string }>(tx, sqlTag`select mantle_heads_check_mode() as m`),
    );
    expect(r.m).toBe('on');
  });

  it('withSystemTx in withSystemTx: a savepoint of the same transaction; hooks follow it', async () => {
    const seen: string[] = [];
    const ids = await m.withSystemTx(async (outer) => {
      const o = await one<{ p: number; t: string }>(
        outer,
        sqlTag`select pg_backend_pid() as p, now()::text as t`,
      );
      const i = await m.withSystemTx(async (inner) => {
        await m.afterCommit(() => seen.push('inner commit'));
        m.afterRollback(() => seen.push('inner rollback'));
        return one<{ p: number; t: string }>(
          inner,
          sqlTag`select pg_backend_pid() as p, now()::text as t`,
        );
      });
      // Not yet: the outer has not committed.
      expect(seen).toEqual([]);
      return [o, i];
    });
    expect(ids[0]).toEqual(ids[1]);
    expect(seen).toEqual(['inner commit']);

    seen.length = 0;
    await expect(
      m.withSystemTx(async () => {
        await m.withSystemTx(async () => {
          await m.afterCommit(() => seen.push('inner commit'));
          m.afterRollback(() => seen.push('inner rollback'));
        });
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');
    expect(seen).toEqual(['inner rollback']);
  });

  it('a caught inner error rolls back the inner writes only; the outer commits its own', async () => {
    const seen: string[] = [];
    const title = async () =>
      (await sql<{ t: string }[]>`select title as t from nodes where id = ${a}`)[0]!.t;
    await m.withSystemTx(async (outer) => {
      await outer.execute(sqlTag`update nodes set title = 'outer 1' where id = ${a}`);
      await m
        .withSystemTx(async (inner) => {
          await m.afterCommit(() => seen.push('inner commit'));
          m.afterRollback(() => seen.push('inner rollback'));
          await inner.execute(sqlTag`update nodes set title = 'inner' where id = ${a}`);
          // An SQL error inside: only the savepoint is aborted.
          await inner.execute(sqlTag`select 1 / 0`);
        })
        .catch(() => undefined);
      expect(seen).toEqual(['inner rollback']);
      // The outer transaction still works and keeps its own write.
      await outer.execute(sqlTag`update nodes set title = 'outer 2' where id = ${a}`);
    });
    expect(await title()).toBe('outer 2');
    expect(seen).toEqual(['inner rollback']);
  });

  it('a second nested call at the same time, or one after the outer ended, is refused', async () => {
    await expect(
      m.withSystemTx(() =>
        Promise.all([
          m.withSystemTx(async () => new Promise((r) => setTimeout(r, 30))),
          m.withSystemTx(async () => undefined),
        ]),
      ),
    ).rejects.toThrow(/another nested call/);
    let detached: Promise<unknown> | null = null;
    await m.withSystemTx(async () => {
      detached = (async () => {
        await new Promise((r) => setTimeout(r, 50));
        return m.withSystemTx(async () => 'late');
      })();
      detached.catch(() => undefined);
    });
    await expect(detached).rejects.toThrow(/after its transaction ended/);
  });

  it('withHeads in withHeads takes more heads, never a second first lock', async () => {
    const before = await misses();
    await m.withHeads([a], 'update', async () => {
      await m.withHeads([b], 'update', async (inner) => {
        expect(await held(inner)).toEqual([a, b].sort());
        await inner.execute(sqlTag`update nodes set title = title where id = ${b}`);
      });
      // The same heads once more: nothing new to lock.
      await m.withHeads([a, b], 'share', async () => undefined);
    });
    expect(await misses()).toBe(before);
  });

  it('withHeads in a withSystemTx that holds none takes the first lock', async () => {
    await m.withSystemTx(async () => {
      await m.withHeads([a], 'update', async (tx) => {
        expect(await held(tx)).toEqual([a]);
      });
      // Now it holds heads: the next nested one takes more.
      await m.withHeads([b], 'update', async (tx) => {
        expect(await held(tx)).toEqual([a, b].sort());
      });
    });
  });

  it('the insert and delete heads nest too, reading on the open transaction', async () => {
    const made = randomUUID();
    await m.withHeads([a], 'update', async (tx) => {
      await m.withNodeInsertHeads(owner, [{ type: 'note', path: 'notes.a2b.sub' }], async (t) => {
        expect(await held(t)).toEqual([a, sub].sort());
        await t.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${made}, ${owner}, 'note', 'a2b made', 'notes.a2b.sub')`);
      });
      // The row made above is seen by the delete heads read (same transaction).
      await m.withNodeDeleteHeads([made], async (t) => {
        expect(await held(t)).toContain(made);
        await t.execute(sqlTag`delete from nodes where id = ${made}`);
      });
      expect(await held(tx)).toContain(a);
    });
  });

  it('heads taken for no rows are heads taken: a nested withHeads takes more', async () => {
    await m.withHeads([], 'update', async () => {
      await m.withHeads([b], 'update', async (tx) => {
        expect(await held(tx)).toEqual([b]);
      });
    });
  });

  it('the database refuses a nested subtree lock where heads are held, allows it where none are', async () => {
    await expect(
      m.withHeads([a], 'update', () => m.withSubtreeHeads(sub, [], async () => undefined)),
    ).rejects.toSatisfy(
      (e: { code?: string; cause?: { code?: string } }) => (e.cause?.code ?? e.code) === '55000',
    );
    await m.withSystemTx(() =>
      m.withSubtreeHeads(sub, [], async (tx) => {
        expect(await held(tx)).toEqual(expect.arrayContaining([sub, b]));
      }),
    );
  });

  it('withDeadlockRetry inside an open transaction runs once; the outermost retries', async () => {
    let inner = 0;
    let outer = 0;
    const busy = () => Object.assign(new Error('busy'), { code: '55P03' });
    await m.withDeadlockRetry(() =>
      m.withHeads([a], 'update', async () => {
        outer += 1;
        if (outer === 1) {
          await m.withDeadlockRetry(async () => {
            inner += 1;
            throw busy();
          });
        }
      }),
    );
    expect(inner).toBe(1);
    expect(outer).toBe(2);
  });

  it('a nested call with another actor or create home is refused', async () => {
    const other = m.loginActor(owner, 'ro');
    await expect(
      m.withSystemTx(() => m.runAsActor(other, () => m.withSystemTx(async () => undefined))),
    ).rejects.toThrow(/different actor/);
    const home = { createWs: null, privateWs: null };
    await m.withCreateHome(home, () =>
      m.withSystemTx(() =>
        // The same home: reused.
        m.withCreateHome(home, () => m.withSystemTx(async () => undefined)),
      ),
    );
    await expect(
      m.withCreateHome(home, () =>
        m.withSystemTx(() =>
          m.withCreateHome({ createWs: null, privateWs: null, quiet: true }, () =>
            m.withSystemTx(async () => undefined),
          ),
        ),
      ),
    ).rejects.toThrow(/different create home/);
  });

  it('more than 32 nested calls in one transaction warn once (A2b1 fix round 2, L2)', async () => {
    const { NESTED_SAVEPOINT_WARN } = await import('./client');
    expect(NESTED_SAVEPOINT_WARN).toBe(32);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const nested = (n: number) =>
        m.withSystemTx(async () => {
          for (let i = 0; i < n; i += 1) await m.withSystemTx(async () => undefined);
        });
      await nested(NESTED_SAVEPOINT_WARN);
      expect(warn.mock.calls.filter((c) => /nested calls/.test(String(c[0])))).toHaveLength(0);
      await nested(NESTED_SAVEPOINT_WARN * 2);
      const calls = warn.mock.calls.filter((c) => /nested calls/.test(String(c[0])));
      expect(calls).toHaveLength(1);
      expect(String(calls[0]![0])).toMatch(/more than 32 nested calls in one transaction/);
    } finally {
      warn.mockRestore();
    }
  });

  it('a first heads lock in a savepoint that rolls back leaves the transaction id: a later first lock is refused (L3)', async () => {
    await expect(
      m.withSystemTx(async () => {
        await m
          .withHeads([a], 'update', async () => {
            throw new Error('inner fails');
          })
          .catch(() => undefined);
        // The savepoint took back the signed held list, not the
        // transaction id the lock took: this is no longer a first lock.
        await m.withHeads([b], 'update', async () => undefined);
      }),
    ).rejects.toMatchObject({
      cause: { code: '55000', message: expect.stringMatching(/first lock of the transaction/) },
    });
  });

  it('withHeads works under every actor kind with heads_check on', async () => {
    const actors: Actor[] = [
      m.loginActor(owner, 'rw'),
      m.loginActor(owner, 'ro'),
      m.loginActor(owner, 'owner'),
      { kind: 'assistant', agentId: null },
      { kind: 'link' },
      { kind: 'contact', canWrite: true },
      { kind: 'contact', canWrite: false },
      { kind: 'peer', peerId: null },
      m.systemActor('worker:test'),
    ];
    const before = await misses();
    for (const actor of actors) {
      const r = await m.runAsActor(actor, () =>
        m.withHeads([a], 'update', async (tx) => {
          await tx.execute(sqlTag`update nodes set title = title where id = ${a}`);
          // Nested under the same actor too.
          await m.withHeads([b], 'update', async () => undefined);
          return one<{ actor: string; w: string; h: string[] }>(
            tx,
            sqlTag`select current_setting('mantle.actor', true) as actor,
                          current_setting('mantle.write_mode', true) as w,
                          mantle_heads_held() as h`,
          );
        }),
      );
      expect(r.actor, JSON.stringify(actor)).toBe(m.actorSetting(actor));
      expect([...r.h].sort()).toEqual([a, b].sort());
    }
    expect(await misses()).toBe(before);
  });
});
