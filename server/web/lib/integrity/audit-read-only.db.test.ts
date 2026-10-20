/**
 * The corpus audit runs every check in one READ ONLY transaction
 * (readOnlyTransaction, @mantle/db), against a real, migrated Postgres:
 *  - no check needs a write: the whole audit completes on the test anchor,
 *    the five checks that run shared catalog text through readSql among
 *    them;
 *  - the transaction is read only: a function readSql does not list that
 *    writes (a test-only function that inserts, and one that calls
 *    nextval) is refused by Postgres (25006) and leaves nothing, where the
 *    same call outside it writes.
 *
 * Makes its own objects (unique names) and drops them after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/integrity/audit-read-only.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The SQLSTATE of a postgres.js error, or of the error drizzle wraps. */
function codeOf(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

describe.skipIf(!URL)('the corpus audit runs read only', () => {
  let m: typeof import('@mantle/db');
  let sql: import('postgres').Sql;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `s10ro${randomUUID().slice(0, 8)}`;
  const table = `${tag}_t`;
  const seq = `${tag}_s`;
  const insertFn = `${tag}_insert`;
  const nextFn = `${tag}_next`;

  const su = async (q: string) => (await import('@mantle/db/test-support')).superuserExec(URL!, q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    sql = (m.systemDb as unknown as { $client: import('postgres').Sql }).$client;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    anchor = await ensureTestAnchor(sql);
    await su(`create table public.${table} (n int)`);
    await su(`grant all on public.${table} to public`);
    await su(`create sequence public.${seq}`);
    await su(`grant all on sequence public.${seq} to public`);
    await su(
      `create function public.${insertFn}() returns int language sql
         as $f$ insert into public.${table} values (1) returning 1 $f$`,
    );
    await su(
      `create function public.${nextFn}() returns bigint language sql
         as $f$ select nextval('public.${seq}') $f$`,
    );
  }, 60_000);

  afterAll(async () => {
    if (anchor) {
      await su(`drop function if exists public.${insertFn}()`);
      await su(`drop function if exists public.${nextFn}()`);
      await su(`drop table if exists public.${table}`);
      await su(`drop sequence if exists public.${seq}`);
    }
    await m?.closeDb();
  });

  const rowsIn = async () =>
    Number((await sql.unsafe(`select count(*)::int as n from public.${table}`))[0]!.n);

  it('completes every check with no write, the readSql checks among them', async () => {
    const { runCorpusAudit } = await import('./audit');
    const report = await runCorpusAudit(anchor);
    const keys = report.checks.map((c) => c.key);
    for (const key of [
      'actor_check_drift',
      'edit_check_drift',
      'check_floor',
      'runtime_role_lock',
      'workspaces_grant_drift',
    ]) {
      expect(keys).toContain(key);
    }
  }, 120_000);

  it('holds its checks in a read-only transaction', async () => {
    const on = await m.readOnlyTransaction(async (tx) => {
      const r = (await tx.execute(
        sqlTag`select current_setting('transaction_read_only') as v`,
      )) as unknown as {
        v: string;
      }[];
      return r[0]!.v;
    });
    expect(on).toBe('on');
  });

  it('refuses an unlisted writer, which writes outside it', async () => {
    for (const fn of [insertFn, nextFn]) {
      const text = `select public.${fn}() as x`;
      expect(m.readSql(text)).toBe(text);
      const err = await m
        .readOnlyTransaction((tx) => tx.execute(sqlTag.raw(m.readSql(text))))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(codeOf(err), `${fn}: ${String(err)}`).toBe('25006');
    }
    expect(await rowsIn()).toBe(0);
    await sql.unsafe(`select public.${insertFn}()`);
    expect(await rowsIn()).toBe(1);
  });
});
