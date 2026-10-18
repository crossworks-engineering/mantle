/**
 * The fail-open count on a real, migrated Postgres (plan v3.2 S4a): a hit
 * writes its miss row (actor_check_misses, check 'fail-open:<site>', the
 * calling file) through mantle_actor_miss_log, after the statement, once
 * per site and file; the raw write site (loginWriteClient) and the typed
 * write site count a login's scoped write to a table the write role does
 * not hold, and the write still runs where it ran (the system pool); system
 * work is never counted. The query is the box script's
 * (scripts/arch-scoreboard-box.sh, fail_open_misses).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/fail-open.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('fail-open miss rows (plan v3.2 S4a)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  let fo: typeof import('./fail-open');
  const login = randomUUID();
  const ws = randomUUID();

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    v = await import('./viewer');
    fo = await import('./fail-open');
    // The pool (and with it the row writer) is made on first use.
    await m.systemDb.execute(sql`select 1`);
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  /** The rows by site, as the box script counts them. */
  const rowsBySite = async (): Promise<Record<string, number>> => {
    const rows = await su<{ check_name: string; n: number }[]>`
      select check_name, count(*)::int as n from actor_check_misses
       where check_name like 'fail-open:%' group by check_name`;
    return Object.fromEntries(rows.map((r) => [r.check_name, r.n]));
  };
  /** The row is written on another connection after a tick. */
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const inWriteRequest = <T>(fn: () => Promise<T>): Promise<T> =>
    v.runInRequestSlot(async () => {
      const scope = Object.freeze({
        kind: 'user' as const,
        loginId: login,
        ws: Object.freeze([ws]),
        modWs: Object.freeze([]),
      });
      expect(v.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
      return fn();
    });

  it('a scoped raw write to a system table: counted once, and it still runs', async () => {
    fo.resetFailOpenForTest();
    await su`delete from actor_check_misses`;
    const write = () =>
      m.executeWrite(
        sql`update "public"."provider_alerts" set provider = provider where false`,
      ) as unknown as Promise<unknown>;
    await inWriteRequest(async () => {
      await write();
      await write();
    });
    await settle();
    expect(await rowsBySite()).toEqual({ 'fail-open:raw-write': 1 });
    const [row] = await su<{ actor: string; detail: string; source: string }[]>`
      select actor, detail, source from actor_check_misses where check_name = 'fail-open:raw-write'`;
    expect(row).toMatchObject({ actor: 'login', source: 'ts' });
    expect(row!.detail).toMatch(/fail-open\.db\.test\.ts$/);
    expect(fo.takeFailOpenHits()).toEqual([
      { site: 'raw-write', actor: 'login', table: 'public.provider_alerts' },
      { site: 'raw-write', actor: 'login', table: 'public.provider_alerts' },
    ]);
  });

  it('a scoped typed write to a system table: counted, it still runs on the system pool', async () => {
    fo.resetFailOpenForTest();
    await su`delete from actor_check_misses`;
    await inWriteRequest(async () => {
      await m.db
        .update(m.providerAlerts)
        .set({ provider: 'x' })
        .where(sql`false`);
    });
    await settle();
    expect(await rowsBySite()).toEqual({ 'fail-open:typed-write': 1 });
    fo.takeFailOpenHits();
  });

  it('system work and an unscoped yes under a system actor: no row', async () => {
    fo.resetFailOpenForTest();
    await su`delete from actor_check_misses`;
    await m.runAsSystem('worker:fail-open-test', async () => {
      await m.executeWrite(
        sql`update "public"."provider_alerts" set provider = provider where false`,
      );
      expect(await m.scopeHoldsAdmin()).toBe(true);
      expect(await m.scopeHasArea('users')).toBe(true);
    });
    await settle();
    expect(await rowsBySite()).toEqual({});
    expect(fo.takeFailOpenHits()).toEqual([]);
  });

  it('an unscoped yes with no actor bound: one row per site', async () => {
    fo.resetFailOpenForTest();
    await su`delete from actor_check_misses`;
    await m.runWithoutActor(async () => {
      expect(await m.scopeHoldsAdmin()).toBe(true);
      expect(await m.scopeHoldsAdmin()).toBe(true);
      expect(await m.scopeHasArea('settings')).toBe(true);
    });
    await settle();
    expect(await rowsBySite()).toEqual({
      'fail-open:scope-holds-admin': 1,
      'fail-open:scope-has-area': 1,
    });
    fo.takeFailOpenHits();
  });
});
