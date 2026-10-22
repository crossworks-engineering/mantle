/**
 * A system transaction inside a narrow exit (plan v3.2 S7b part b2): where
 * withSystemTx (and the helpers built on it: the heads, the hidden-rows
 * check) runs when an Admin area's exit picked the narrow route, as the
 * request's own exit and as an asSystem exit, against the same work on the
 * full route. Each statement reports who it ran as (current_user,
 * session_user) and the settings it carried (the acting login, the actor).
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureAdminUsers, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Who = { cu: string; su: string; acting: string; actor: string };

describe.skipIf(!URL)('a system transaction inside a narrow exit', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let rr: typeof import('./runtime-role');
  let v: typeof import('./viewer');
  let m: typeof import('./index');
  let pools: typeof import('./gateway/pools');
  let actor: typeof import('./actor');
  let su: ReturnType<typeof postgres>;
  let brain = '';
  let systemLogin = '';
  const admin = randomUUID();

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(su);
    await su`insert into auth.users (id, email, password_hash, role)
             values (${admin}, ${`${admin}@example.test`}, 'x', 'admin')`;
    await ensureAdminUsers(su, [admin]);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('./runtime-role');
    // The narrow route whatever the run's switch: the cells are about it.
    rr.setNarrowSystemForTests(true);
    v = await import('./viewer');
    m = await import('./index');
    pools = await import('./gateway/pools');
    actor = await import('./actor');
    const [r] = await pools.getAdminDb().execute<{ u: string }>(sql`select current_user as u`);
    systemLogin = r!.u;
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    rr?.setNarrowSystemForTests(null);
    await su?.end();
    await scratch?.drop();
  });

  const WHO = sql`select current_user::text as cu, session_user::text as su,
                         coalesce(current_setting('mantle.acting_login', true), '') as acting,
                         coalesce(current_setting('mantle.actor', true), '') as actor`;
  const who = async (q: { execute: (s: typeof WHO) => Promise<unknown> }): Promise<Who> => {
    const rows = (await q.execute(WHO)) as unknown as Who[];
    return rows[0]!;
  };

  /** `fn` in the Admin area's request exit of the Admin login. */
  const requestExit = <T>(fn: () => Promise<T>) =>
    m.runInRequestSlot(async () => {
      m.setRequestActor(m.loginActor(admin, 'rw'));
      m.noteRequestSystem('area');
      return fn();
    });
  /** `fn` in an asSystem('admin-area') exit of the Admin login. */
  const asSystemExit = <T>(fn: () => Promise<T>) =>
    m.runAsActor(m.loginActor(admin, 'rw'), () => m.asSystem(fn, 'admin-area'));

  /** Every way a system transaction's work reaches the database. */
  const probe = () =>
    m.withSystemTx(async (tx) => {
      const out: Record<string, Who | string | null> = {};
      out.tx = await who(tx);
      out.db = await who(m.db);
      out.nested = await m.withSystemTx((t2) => who(t2));
      // A statement on the pool itself and on the infrastructure handle,
      // inside the system transaction (each a connection of its own).
      out.pool = await who(pools.getAdminDb());
      out.systemDb = await who(m.systemDb);
      out.route = v.systemRouteNow();
      out.acting = v.actingLoginNow();
      return out;
    });

  it('a narrow exit: withSystemTx runs as the narrow login with the acting login', async () => {
    const seen: Record<string, Awaited<ReturnType<typeof probe>>> = {};
    for (const [name, exit] of [
      ['request exit', requestExit],
      ['asSystem exit', asSystemExit],
    ] as const) {
      seen[name] = await exit(probe);
      console.log(`[probe] ${name}: ${JSON.stringify(seen[name])}`);
    }
    for (const name of Object.keys(seen)) {
      const out = seen[name]!;
      for (const k of ['tx', 'db', 'nested', 'pool', 'systemDb'] as const) {
        const w = out[k] as Who;
        expect({ name, k, ...w }).toMatchObject({
          name,
          k,
          cu: rr.NARROW_ROLE,
          su: rr.NARROW_ROLE,
          acting: admin,
        });
      }
      expect({ name, route: out.route, acting: out.acting }).toEqual({
        name,
        route: 'narrow',
        acting: admin,
      });
    }
  });

  it('a narrow exit: a content write through the heads (a withSystemTx) is refused, nothing written', async () => {
    for (const exit of [requestExit, asSystemExit]) {
      const err = await exit(() =>
        m.withNodeInsertHeads(brain, [{ type: 'note', path: 'n' }], (tx) => who(tx)),
      ).catch((e: unknown) => e);
      expect(m.pgErrorCode(err)).toBe('42501');
      const denied = actor.takeNarrowDenials();
      expect(denied.map((d) => d.what)).toEqual([
        expect.stringContaining('permission denied for function mantle_lock_heads'),
      ]);
    }
  });

  it('a full exit: withSystemTx stays on the system pool, the acting login still sent', async () => {
    const out = await requestExit(() => v.onFullSystemRoute('profile-row', probe));
    console.log(`[probe] full: ${JSON.stringify(out)}`);
    for (const k of ['tx', 'db', 'nested', 'pool', 'systemDb'] as const) {
      const w = out[k] as Who;
      expect({ k, ...w }).toMatchObject({ k, cu: systemLogin, su: systemLogin });
    }
    expect(out.route).toBe('full');
    const full = await m.runAsActor(m.loginActor(admin, 'rw'), () => m.asSystem(probe, 'app-data'));
    expect((full.tx as Who).su).toBe(systemLogin);
    expect(full.route).toBe('full');
  });
});
