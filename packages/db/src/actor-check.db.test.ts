/**
 * The actor check, warn only (workspaces arch A2a, migration 0275 and
 * actor.ts): the mode reads like the heads check (a session only raises
 * it), an item table's write with no actor is a NOTICE (never a refusal,
 * never a row in the transaction), the setters are not the workspace
 * role's, the miss log is capped, and the app's system pool sets the actor
 * on its transactions and on each write it sends.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/actor-check.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql as sqlTag } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the actor check (arch A2a)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  const notices: string[] = [];
  const owner = randomUUID();

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, {
      max: 1,
      prepare: false,
      onnotice: (n) => notices.push(String(n.message ?? '')),
    });
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  /** A write on an item table that changes no row (the statement trigger
   *  still fires). */
  const touch = (tx: postgres.TransactionSql) =>
    tx`update nodes set title = title where id = ${randomUUID()}`;

  it('the mode: off by default, raised by a session, never lowered', async () => {
    const [a] = await sql`select mantle_actor_check_mode() as m`;
    expect(a!.m).toBe('off');
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor_check', 'warn', true)`;
      const [b] = await tx`select mantle_actor_check_mode() as m`;
      expect(b!.m).toBe('warn');
    });
    await sql.unsafe(`alter database "${scratch.name}" set mantle.actor_check = 'warn'`);
    try {
      const low = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
      try {
        await low.begin(async (tx) => {
          await tx`select set_config('mantle.actor_check', 'off', true)`;
          const [c] = await tx`select mantle_actor_check_mode() as m`;
          expect(c!.m).toBe('warn');
        });
      } finally {
        await low.end();
      }
    } finally {
      await sql.unsafe(`alter database "${scratch.name}" reset mantle.actor_check`);
    }
  });

  it('warn: a write with no actor is one NOTICE per transaction and table, and runs', async () => {
    notices.length = 0;
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor_check', 'warn', true)`;
      await touch(tx);
      await touch(tx);
      // No transaction id was taken: the miss writes nothing here.
      const [x] = await tx`select pg_current_xact_id_if_assigned() as x`;
      expect(x!.x).toBeNull();
    });
    expect(notices.filter((n) => n.startsWith('mantle actor miss: '))).toEqual([
      'mantle actor miss: UPDATE on nodes',
    ]);
    // 'on' still only logs in A2a.
    notices.length = 0;
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor_check', 'on', true)`;
      await touch(tx);
    });
    expect(notices).toEqual(['mantle actor miss: UPDATE on nodes']);
  });

  it('no NOTICE with an actor set, or with the check off', async () => {
    notices.length = 0;
    await sql.begin(async (tx) => {
      await tx`select mantle_set_actor('system:test', 'rw', 'warn')`;
      await touch(tx);
      const [s] = await tx`select current_setting('mantle.actor') as a,
                                  current_setting('mantle.write_mode') as w`;
      expect(s).toEqual({ a: 'system:test', w: 'rw' });
    });
    await sql.begin(async (tx) => {
      await touch(tx);
    });
    expect(notices).toEqual([]);
  });

  it('the setter takes the six kinds only, and a write mode of rw or ro', async () => {
    const id = randomUUID();
    const good = [
      `login:rw:${id}`,
      `login:ro:${id}`,
      `login:owner:${id}`,
      `assistant:${id}`,
      'assistant:none',
      'link',
      'contact:rw',
      'contact:ro',
      'system:worker:extract',
      `peer:${id}`,
    ];
    for (const a of good) {
      await sql.begin((tx) => tx`select mantle_set_actor(${a}, 'ro')`);
    }
    for (const [a, w] of [
      ['owner', 'rw'],
      ['system:', 'rw'],
      ['login:rw:x', 'rw'],
      ['system:x', 'rw!'],
    ] as const) {
      await expect(
        sql.begin((tx) => tx`select mantle_set_actor(${a}, ${w})`),
        `${a} ${w}`,
      ).rejects.toMatchObject({ code: '22023' });
    }
  });

  it('the workspace role cannot run the setters or the miss log', async () => {
    for (const q of [
      `select mantle_set_actor('system:x', 'rw')`,
      `select mantle_operator_actor('x')`,
      `select mantle_actor_miss_log('ts', 'x', '', '')`,
    ]) {
      await expect(
        sql.begin(async (tx) => {
          await tx`set local role mantle_view_user`;
          await tx.unsafe(q);
        }),
        q,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('the operator actor names a psql session', async () => {
    const op = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const [r] = await op`select mantle_operator_actor('fix-slug') as a`;
      expect(r!.a).toBe('system:operator:fix-slug');
      const [s] = await op`select current_setting('mantle.actor') as a`;
      expect(s!.a).toBe('system:operator:fix-slug');
      await expect(op`select mantle_operator_actor('Fix Slug')`).rejects.toMatchObject({
        code: '22023',
      });
    } finally {
      await op.end();
    }
  });

  it('the miss log keeps at most 100 rows an hour per check', async () => {
    const check = `cap-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 105; i++) {
      await sql`select mantle_actor_miss_log('ts', ${check}, '', ${`n${i}`})`;
    }
    const [n] =
      await sql`select count(*)::int as n from actor_check_misses where check_name = ${check}`;
    expect(n!.n).toBe(100);
  });

  it('the app pool sets the actor on a write it sends and on a transaction', async () => {
    const q = sqlTag`with u as (update nodes set title = title where owner_id = ${owner})
                     select current_setting('mantle.actor', true) as a,
                            current_setting('mantle.write_mode', true) as w`;
    const write = (await m.runAsActor(m.loginActor(owner, 'ro'), () =>
      m.db.execute(q),
    )) as unknown as { a: string; w: string }[];
    expect(write[0]).toEqual({ a: `login:ro:${owner}`, w: 'ro' });
    const tx = await m.runAsSystem('worker:test', () =>
      m.withSystemTx(async (t) =>
        t.execute(sqlTag`select current_setting('mantle.actor', true) as a`),
      ),
    );
    expect((tx as unknown as { a: string }[])[0]!.a).toBe('system:worker:test');
    // A read carries it too (a function it calls may write).
    const read = (await m.runAsSystem('worker:test', () =>
      m.db.execute(sqlTag`select current_setting('mantle.actor', true) as a`),
    )) as unknown as { a: string | null }[];
    expect(read[0]!.a).toBe('system:worker:test');
    expect(m.takeActorMisses()).toEqual([]);
  });

  it('a statement with no actor is a miss; one a test sends itself is not', async () => {
    // The test is the process entry here: system(test).
    await m.db.execute(sqlTag`select 1`);
    expect(m.takeActorMisses()).toEqual([]);
    // As an entry that forgot its actor runs.
    await m.runWithoutActor(() => m.db.execute(sqlTag`select 1`));
    const misses = m.takeActorMisses();
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ source: 'ts', check: 'db.execute' });
  });
});
