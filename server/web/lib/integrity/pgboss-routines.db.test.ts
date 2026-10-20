/**
 * pg-boss's own routines on a real, migrated Postgres with pg-boss's real
 * schema (plan v3.2 S7a): pg-boss makes them with PUBLIC's default EXECUTE,
 * and job_table_run runs its text argument as SQL as its caller, so the
 * narrow system role could leave its role through it. pgboss:init's
 * statement (@mantle/db revokePgBossRoutines, run right after
 * pg-boss installs) and every migrate take EXECUTE from PUBLIC; the
 * runtime lock's integrity row names a routine still open. A database of
 * its own: the shared test database keeps pg-boss as other files left it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/integrity/pgboss-routines.db.test.ts
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const JOB_TABLE_RUN = 'pgboss.job_table_run(text,text,text)';

describe.skipIf(!URL)("pg-boss's routines are not PUBLIC's", () => {
  let scratch: { url: string; drop: () => Promise<void> };
  let su: postgres.Sql;
  let db: typeof import('@mantle/db');

  /** Who may run job_table_run: the runtime role, the narrow role, PUBLIC. */
  const can = async () =>
    (
      await su<{ r: boolean; n: boolean; p: boolean }[]>`
        select has_function_privilege('mantle_runtime', ${JOB_TABLE_RUN}, 'EXECUTE') as r,
               has_function_privilege('mantle_system_narrow', ${JOB_TABLE_RUN}, 'EXECUTE') as n,
               has_function_privilege('public', ${JOB_TABLE_RUN}, 'EXECUTE') as p`
    )[0];

  /** As the narrow role on the superuser's session, job_table_run with a
   *  role change as its text: who the transaction is afterwards, or the
   *  error. Rolled back. */
  const leaveThroughJobTableRun = () =>
    su
      .begin(async (t) => {
        await t.unsafe(`select set_config('role', 'mantle_system_narrow', true)`);
        await t.unsafe(
          `select pgboss.job_table_run('select set_config(''role'', ''none'', true)')`,
        );
        const [r] = await t.unsafe<{ u: string }[]>('select current_user as u');
        throw Object.assign(new Error('rollback'), { u: r!.u });
      })
      .catch((err: { u?: string; message?: string }) => err.u ?? String(err.message));

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, onnotice: () => {} });
    db = await import('@mantle/db');
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss({ connectionString: scratch.url, schema: 'pgboss' });
    await boss.start();
    await boss.stop({ graceful: false, timeout: 5_000 });
  }, 180_000);

  afterAll(async () => {
    await su?.end();
    await scratch?.drop();
  });

  it("an install leaves job_table_run open and a way out of the narrow role; pgboss:init's statement closes it", async () => {
    expect(await can()).toEqual({ r: true, n: true, p: true });
    expect(await leaveThroughJobTableRun()).toBe('postgres');
    const open = (await su.unsafe(db.RUNTIME_LOCK_SQL)) as unknown as { detail: string }[];
    expect(open[0]?.detail).toMatch(/may run pg-boss routines: .*job_table_run/);
    await db.revokePgBossRoutines(su);
    expect(await can()).toEqual({ r: false, n: false, p: false });
    expect(await leaveThroughJobTableRun()).toMatch(/permission denied for function job_table_run/);
    expect(await su.unsafe(db.RUNTIME_LOCK_SQL)).toEqual([]);
    // pg-boss as its owner still runs (a queue made, a job sent).
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss({ connectionString: scratch.url, schema: 'pgboss' });
    await boss.start();
    try {
      await boss.createQueue('s7a3g-probe');
      expect(await boss.send('s7a3g-probe', { a: 1 })).toEqual(expect.any(String));
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
    }
  });
});
