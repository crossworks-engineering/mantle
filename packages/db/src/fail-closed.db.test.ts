/**
 * The fail-closed branches on a real, migrated Postgres (plan v3.2 S4b; S4a
 * counted them as fail-open): a login's scoped typed write to a table the
 * write role does not hold is refused before it is sent, and no row
 * changes; a table that names scopedSystemWrite and the use counters
 * (systemDb) still write; a scoped raw write to such a table goes to the
 * write role, which refuses it; system work still takes the unscoped yes,
 * and with no actor bound the yes throws. No miss row is written for any
 * of them. And 0340: on a brain with no Admin workspace mantle_login_area
 * answers no (its rollback puts 0304's yes back).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/fail-closed.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('fail-closed branches (plan v3.2 S4b)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  const login = randomUUID();
  const ws = randomUUID();

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    v = await import('./viewer');
    await m.systemDb.execute(sql`select 1`);
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  /** No fail-open row is written any more (S4a's check names). */
  const failOpenRows = async () =>
    (
      await su<{ n: number }[]>`select count(*)::int as n from actor_check_misses
        where check_name like 'fail-open:%'`
    )[0]!.n;
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

  it('a scoped typed write to a system table: refused before it is sent', async () => {
    const before = await su<{ n: number }[]>`select count(*)::int as n from provider_alerts`;
    const failed = await inWriteRequest(async () =>
      Promise.resolve()
        .then(() =>
          m.db.insert(m.providerAlerts).values({
            ownerId: login,
            subject: 'fc-test',
            code: 'x',
            permanent: false,
            reason: 'x',
          }),
        )
        .then(
          () => null,
          (err: unknown) => err,
        ),
    );
    expect(failed).toBeInstanceOf(v.SystemWorkRequiredError);
    expect(String((failed as Error).message)).toMatch(/public\.provider_alerts/);
    const after = await su<{ n: number }[]>`select count(*)::int as n from provider_alerts`;
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(await failOpenRows()).toBe(0);
  });

  it('a scoped raw write to a system table: the write role refuses it (42501)', async () => {
    const failed = await inWriteRequest(async () =>
      (
        m.executeWrite(
          sql`update "public"."provider_alerts" set provider = provider where false`,
        ) as unknown as Promise<unknown>
      ).then(
        () => null,
        (err: unknown) => err as { code?: string; cause?: { code?: string } },
      ),
    );
    expect(failed?.cause?.code ?? failed?.code).toBe('42501');
    // Met on purpose: the gateway's write-role gap, taken here.
    expect(m.takeWriteRoleGaps()).toEqual(['permission denied for table provider_alerts']);
  });

  it('a table that names scopedSystemWrite, and the use counters: still written', async () => {
    const am = await import('./access-matrix');
    expect(Object.keys(am.SCOPED_SYSTEM_WRITE)).toEqual(['public.item_marks']);
    await inWriteRequest(async () => {
      await m.db
        .update(m.itemMarks)
        .set({ openCount: 1 })
        .where(sql`false`);
    });
    const owner = randomUUID();
    await su`insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`fc-${owner.slice(0, 8)}@example.invalid`}, 'x', 'member')`;
    const [w] = await su<{ id: string }[]>`
      insert into ai_workers (owner_id, slug, name, kind, provider, model)
      values (${owner}, ${`fc-${randomUUID().slice(0, 8)}`}, 'w', 'tts', 'openai', 'x')
      returning id::text`;
    const [a] = await su<{ id: string }[]>`
      insert into agents (owner_id, slug, name, provider, model, system_prompt)
      values (${owner}, ${`fc-${randomUUID().slice(0, 8)}`}, 'a', 'openai', 'x', '')
      returning id::text`;
    await inWriteRequest(async () => {
      await m.bumpWorkerUsage(w!.id);
      await m.bumpAgentUsage(a!.id);
    });
    const counts = await su<{ n: string }[]>`
      select usage_count::text as n from ai_workers where id = ${w!.id}
      union all select usage_count::text from agents where id = ${a!.id}`;
    expect(counts.map((r) => r.n)).toEqual(['1', '1']);
    await su`delete from ai_workers where id = ${w!.id}`;
    await su`delete from agents where id = ${a!.id}`;
    await su`delete from auth.users where id = ${owner}`;
  });

  it('system work takes the unscoped yes; with no actor bound it throws', async () => {
    await m.runAsSystem('worker:fail-closed-test', async () => {
      expect(await m.scopeHoldsAdmin()).toBe(true);
      expect(await m.scopeHasArea('users')).toBe(true);
    });
    await m.runWithoutActor(async () => {
      await expect(m.scopeHoldsAdmin()).rejects.toBeInstanceOf(v.SystemWorkRequiredError);
      await expect(m.scopeHasArea('settings')).rejects.toBeInstanceOf(v.SystemWorkRequiredError);
    });
    expect(await failOpenRows()).toBe(0);
  });

  it('0340: with no Admin workspace mantle_login_area answers no; the rollback puts the yes back', async () => {
    const revert = readFileSync(
      new globalThis.URL('../rollback/0340_s4b_fail_closed.revert.sql', import.meta.url),
      'utf8',
    );
    const ask = async (tx: postgres.TransactionSql) =>
      (
        await tx<{ a: boolean }[]>`
          select mantle_login_area(${randomUUID()}::uuid, 'users') as a`
      )[0]!.a;
    const seen: boolean[] = [];
    await su
      .begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`delete from workspaces where is_admin`;
        seen.push(await ask(tx));
        // A scratch copy has no ledger: the revert's own DELETE needs one.
        await tx`create schema if not exists "drizzle"`;
        await tx`create table if not exists "drizzle"."__drizzle_migrations" (
          id serial primary key, hash text not null, created_at bigint)`;
        await tx`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
          values ('0340', 1790200560000)`;
        await tx.unsafe(revert);
        seen.push(
          (
            await tx<{ n: number }[]>`select count(*)::int as n
              from "drizzle"."__drizzle_migrations" where created_at = 1790200560000`
          )[0]!.n === 0,
        );
        seen.push(await ask(tx));
        throw new Error('roll back');
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== 'roll back') throw err;
      });
    // No: no area; the revert took 0340 off the ledger; then yes again.
    expect(seen).toEqual([false, true, true]);
  });
});
