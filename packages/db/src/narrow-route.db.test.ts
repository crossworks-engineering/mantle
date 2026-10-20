/**
 * The narrow system route on a real, migrated Postgres (plan v3.2 S7a part
 * a2, section 2.1 point 3): with MANTLE_NARROW_SYSTEM on, the system pool
 * sends the work of a reason routed 'narrow' (viewer.ts AS_SYSTEM_ROUTE,
 * REQUEST_SYSTEM_ROUTE) as mantle_system_narrow, taken per transaction with
 * the actor's settings; a reason routed 'full', system work and a rebound
 * actor run as the pool's own login; off, nothing changes. The hold check
 * rolls back a transaction that left the role. The archive path's write
 * scope carries the actor's write mode.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/narrow-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const NARROW = 'mantle_system_narrow';

describe.skipIf(!URL)('the narrow system route (plan v3.2 S7a)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  let rr: typeof import('./runtime-role');
  let nr: typeof import('./gateway/narrow-route');
  let actor: typeof import('./actor');
  let su: ReturnType<typeof postgres>;
  let pool = '';

  /** Who the statement ran as, and the actor it carried. */
  type Who = { u: string; a: string };
  const who = async (): Promise<Who> => {
    const rows = (await m.db.execute(
      sql`select current_user as u, coalesce(current_setting('mantle.actor', true), '') as a`,
    )) as unknown as Who[];
    return rows[0]!;
  };
  const whoInTx = (): Promise<Who> =>
    m.db.transaction(async (tx) => {
      const rows = (await tx.execute(
        sql`select current_user as u, coalesce(current_setting('mantle.actor', true), '') as a`,
      )) as unknown as Who[];
      return rows[0]!;
    });
  /** The error a statement failed with: drizzle wraps the driver's. */
  const failure = async (p: Promise<unknown>): Promise<unknown> => {
    try {
      await p;
    } catch (err) {
      return (err as { cause?: unknown }).cause ?? err;
    }
    throw new Error('expected a failure');
  };
  /** The pool reads the switch once, when it opens. */
  const reopen = async (on: boolean) => {
    await m.closeDb();
    rr.setNarrowSystemForTests(on);
    await m.systemDb.execute(sql`select 1`);
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    // A probe table every role may write (this scratch database only): a
    // row written after the role was left must not survive.
    await su.unsafe('create table public.narrow_probe (x text)');
    await su.unsafe('grant select, insert on public.narrow_probe to public');
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    v = await import('./viewer');
    rr = await import('./runtime-role');
    nr = await import('./gateway/narrow-route');
    actor = await import('./actor');
    await reopen(true);
    pool = (await who()).u;
  }, 120_000);

  afterAll(async () => {
    rr?.setNarrowSystemForTests(null);
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  it('is on by default outside production, and every reason picks a route', () => {
    rr.setNarrowSystemForTests(null);
    expect(rr.narrowSystemOn()).toBe(true);
    rr.setNarrowSystemForTests(true);
    const reasons = [...v.AS_SYSTEM_TURN_REASONS, ...v.AS_SYSTEM_OTHER_REASONS];
    expect(Object.keys(v.AS_SYSTEM_ROUTE).sort()).toEqual([...reasons].sort());
    expect(v.REQUEST_SYSTEM_ROUTE).toEqual({ area: 'narrow', 'login-self': 'narrow' });
  });

  it('a narrow reason runs as the narrow role, a statement and a transaction, with its actor', async () => {
    expect(pool).not.toBe(NARROW);
    for (const reason of Object.keys(v.AS_SYSTEM_ROUTE) as (keyof typeof v.AS_SYSTEM_ROUTE)[]) {
      const route = v.AS_SYSTEM_ROUTE[reason];
      const want = route === 'narrow' ? NARROW : pool;
      expect(await v.asSystem(who, reason), reason).toEqual({ u: want, a: expect.any(String) });
      expect((await v.asSystem(whoInTx, reason)).u, `${reason} tx`).toBe(want);
    }
    expect(await v.asSystem(who, 'admin-area')).toEqual({ u: NARROW, a: 'system:admin-area' });
    // System work runs full whatever its reason; a rebound actor too.
    expect((await v.systemWork(who, 'admin-area')).u).toBe(pool);
    expect((await v.asSystem(() => actor.runAsSystem('probe', who), 'admin-area')).u).toBe(pool);
    // Outside any exit: full.
    expect((await who()).u).toBe(pool);
  });

  it('the request exits pick their route (area, login-self)', async () => {
    for (const [why, reason] of [
      ['area', 'http:admin-area'],
      ['login-self', 'http:login-self'],
    ] as const) {
      const got = await v.runInRequestSlot(async () => {
        v.noteRequestSystem(why);
        return { s: await who(), t: await whoInTx() };
      });
      expect(got.s, why).toEqual({ u: NARROW, a: `system:${reason}` });
      expect(got.t.u, why).toBe(NARROW);
    }
    // A request no exit let through: full.
    expect((await v.runInRequestSlot(() => who())).u).toBe(pool);
  });

  it('refuses a content write (noted), writes a system table', async () => {
    expect(
      await failure(
        v.asSystem(
          () => m.db.execute(sql`update public.nodes set title = title where false`),
          'admin-area',
        ),
      ),
    ).toMatchObject({ code: '42501' });
    const denied = actor.takeNarrowDenials();
    expect(denied).toHaveLength(1);
    expect(denied[0]!.actor).toBe('system:admin-area');
    await v.asSystem(
      () => m.db.execute(sql`delete from public.audit_log where false`),
      'admin-area',
    );
    expect(actor.takeNarrowDenials()).toEqual([]);
  });

  it('a full-route spot runs full with its actor inside a narrow exit, and changes nothing elsewhere', async () => {
    // Inside a narrow exit: the spot's statement and transaction run full,
    // as the same actor; around it the exit stays narrow.
    const got = await v.asSystem(
      async () => ({
        spot: await v.onFullSystemRoute('profile-row', who),
        spotTx: await v.onFullSystemRoute('profile-row', whoInTx),
        // A drizzle query handed back unawaited runs where it is awaited.
        spotLazy: await v.onFullSystemRoute('profile-row', () =>
          m.db.execute(sql`select current_user::text as u`),
        ),
        after: await who(),
      }),
      'admin-area',
    );
    expect(got.spot.u).toBe(pool);
    expect(got.spotTx.u).toBe(pool);
    expect((got.spotLazy as unknown as { u: string }[])[0]!.u).toBe(pool);
    expect(got.after).toEqual({ u: NARROW, a: 'system:admin-area' });
    // A content write in a spot is not refused; outside one it is.
    await v.asSystem(
      () =>
        v.onFullSystemRoute('profile-row', () =>
          m.db.execute(sql`update public.profiles set updated_at = updated_at where false`),
        ),
      'admin-area',
    );
    expect(actor.takeNarrowDenials()).toEqual([]);
    // In a request exit too.
    const req = await v.runInRequestSlot(async () => {
      v.noteRequestSystem('login-self');
      return { spot: await v.onFullSystemRoute('profile-row', who), after: await who() };
    });
    expect(req.spot.u).toBe(pool);
    expect(req.after.u).toBe(NARROW);
    // Outside a narrow exit (system work, no exit) the spot changes nothing.
    const work = await v.systemWork(() => v.onFullSystemRoute('profile-row', who), 'admin-area');
    expect(work.u).toBe(pool);
    expect((await v.onFullSystemRoute('profile-row', who)).u).toBe(pool);
  });

  it('rolls back a statement or a transaction that left the role, and refuses transaction control', async () => {
    expect(
      await failure(
        v.asSystem(() => m.db.execute(sql`select set_config('role', 'none', true)`), 'admin-area'),
      ),
    ).toBeInstanceOf(nr.NarrowRoleLeftError);
    const marker = `narrow-left-${randomUUID()}`;
    expect(
      await failure(
        v.asSystem(
          () =>
            m.db.transaction(async (tx) => {
              await tx.execute(sql`select set_config('role', 'none', true)`);
              // As the session's own login now: the hold check must undo this.
              await tx.execute(sql`insert into public.narrow_probe (x) values (${marker})`);
            }),
          'admin-area',
        ),
      ),
    ).toBeInstanceOf(nr.NarrowRoleLeftError);
    const left = await su<{ n: number }[]>`
      select count(*)::int as n from public.narrow_probe where x = ${marker}`;
    expect(left[0]!.n).toBe(0);
    for (const stmt of ['vacuum', 'commit', 'select 1; commit']) {
      expect(
        await failure(v.asSystem(() => m.db.execute(sql.raw(stmt)), 'admin-area')),
        stmt,
      ).toBeInstanceOf(nr.NarrowRouteRefusedError);
    }
    expect(actor.takeNarrowDenials()).toEqual([]);
  });

  it('off: every reason runs as the pool login', async () => {
    await reopen(false);
    try {
      expect((await v.asSystem(who, 'admin-area')).u).toBe(pool);
      expect((await v.asSystem(whoInTx, 'admin-area')).u).toBe(pool);
      const got = await v.runInRequestSlot(async () => {
        v.noteRequestSystem('area');
        return who();
      });
      expect(got.u).toBe(pool);
      expect(actor.takeNarrowUses()).toEqual({});
    } finally {
      await reopen(true);
    }
  });

  it('the system-pool write scope carries the actor write mode (the archive path)', async () => {
    const login = randomUUID();
    const mode = (a: ReturnType<typeof actor.loginActor>) =>
      actor.runAsActor(a, () =>
        m.systemPoolTxInScope({ loginId: login, ws: [], modWs: [] }, async (tx) => {
          const rows = (await tx.execute(
            sql`select current_setting('mantle.write_mode', true) as w`,
          )) as unknown as { w: string }[];
          return rows[0]!.w;
        }),
      );
    expect(await mode(actor.loginActor(login, 'ro'))).toBe('ro');
    expect(await mode(actor.loginActor(login, 'rw'))).toBe('rw');
  });
});
