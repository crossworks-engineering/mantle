/**
 * The fail-open count on a real, migrated Postgres (plan v3.2 S4a): a hit
 * writes its miss row (actor_check_misses, check 'fail-open:<site>', the
 * calling file) through mantle_actor_miss_log, after the statement, once
 * per site and file; the typed write site counts a login's scoped write to
 * a table the write role does not hold, and the write still runs where it
 * ran (the system pool); a scoped raw write to such a table goes to the
 * write role, and Postgres refuses it (no row, no hit); system work is
 * never counted. The query is the box script's
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
  /** The rows once they read as `want` (polled up to 10 s), else as they
   *  are then. */
  const rowsLanded = async (want: Record<string, number>) => {
    let got = await rowsBySite();
    for (let i = 0; i < 100 && JSON.stringify(got) !== JSON.stringify(want); i++) {
      await new Promise((r) => setTimeout(r, 100));
      got = await rowsBySite();
    }
    return got;
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

  it('a scoped raw write to a system table: the write role refuses it, no row and no hit', async () => {
    fo.resetFailOpenForTest();
    await su`delete from actor_check_misses`;
    const write = () =>
      m.executeWrite(
        sql`update "public"."provider_alerts" set provider = provider where false`,
      ) as unknown as Promise<unknown>;
    const failed = await inWriteRequest(async () =>
      write().then(
        () => null,
        (err: unknown) => err as { code?: string; message?: string; cause?: { code?: string } },
      ),
    );
    // Sent on the write role (no table read from the text): Postgres
    // refuses the table the role holds no right on.
    expect(failed?.cause?.code ?? failed?.code).toBe('42501');
    expect(
      String((failed?.cause as { message?: string } | undefined)?.message ?? failed?.message),
    ).toMatch(/permission denied for table provider_alerts/);
    // The gateway notes the refusal as a write-role gap (in production a
    // `write-role-gap` miss row naming the caller; vitest.setup.ts fails any
    // test that leaves one): taken here, as this cell meets it on purpose.
    expect(m.takeWriteRoleGaps()).toEqual(['permission denied for table provider_alerts']);
    await settle();
    expect(await rowsBySite()).toEqual({});
    expect(fo.takeFailOpenHits()).toEqual([]);
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
    // Waits for the row itself (up to 10 s): a row that lands after a
    // fixed wait would be counted by the next cell instead.
    expect(await rowsLanded({ 'fail-open:typed-write:public.provider_alerts': 1 })).toEqual({
      'fail-open:typed-write:public.provider_alerts': 1,
    });
    fo.takeFailOpenHits();
  });

  it('a scoped typed write to a table that names scopedSystemWrite: no hit, still on the system pool', async () => {
    fo.resetFailOpenForTest();
    await su`delete from actor_check_misses`;
    const am = await import('./access-matrix');
    expect(Object.keys(am.SCOPED_SYSTEM_WRITE)).toContain('public.item_marks');
    await inWriteRequest(async () => {
      await m.db
        .update(m.itemMarks)
        .set({ openCount: 1 })
        .where(sql`false`);
    });
    await settle();
    expect(await rowsBySite()).toEqual({});
    expect(fo.takeFailOpenHits()).toEqual([]);
  });

  it("an assistant's and an AI worker's use counters in a write request: systemDb, no hit", async () => {
    fo.resetFailOpenForTest();
    await su`delete from actor_check_misses`;
    // The rows' owner: agents.owner_id names a login (auth.users).
    const owner = randomUUID();
    await su`insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`fo-${owner.slice(0, 8)}@example.invalid`}, 'x', 'member')`;
    const [w] = await su<{ id: string }[]>`
      insert into ai_workers (owner_id, slug, name, kind, provider, model)
      values (${owner}, ${`fo-${randomUUID().slice(0, 8)}`}, 'w', 'tts', 'openai', 'x')
      returning id::text`;
    const [a] = await su<{ id: string }[]>`
      insert into agents (owner_id, slug, name, provider, model, system_prompt)
      values (${owner}, ${`fo-${randomUUID().slice(0, 8)}`}, 'a', 'openai', 'x', '')
      returning id::text`;
    await inWriteRequest(async () => {
      await m.bumpWorkerUsage(w!.id);
      await m.bumpAgentUsage(a!.id);
    });
    const counts = await su<{ n: string }[]>`
      select usage_count::text as n from ai_workers where id = ${w!.id}
      union all select usage_count::text from agents where id = ${a!.id}`;
    expect(counts.map((r) => r.n)).toEqual(['1', '1']);
    await settle();
    expect(await rowsBySite()).toEqual({});
    expect(fo.takeFailOpenHits()).toEqual([]);
    await su`delete from ai_workers where id = ${w!.id}`;
    await su`delete from agents where id = ${a!.id}`;
    await su`delete from auth.users where id = ${owner}`;
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
    const want = { 'fail-open:scope-holds-admin': 1, 'fail-open:scope-has-area': 1 };
    expect(await rowsLanded(want)).toEqual(want);
    fo.takeFailOpenHits();
  });
});
