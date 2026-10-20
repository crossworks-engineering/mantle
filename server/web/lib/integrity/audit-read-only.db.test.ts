/**
 * The corpus audit runs every check in one READ ONLY transaction
 * (readOnlyTransaction, @mantle/db), against a real, migrated Postgres:
 *  - no check needs a write: the whole audit completes on the test anchor,
 *    the five checks that run shared catalog text through readSql among
 *    them;
 *  - the transaction is read only: a function readSql does not list that
 *    writes (a test-only function that inserts an entity, and one that
 *    calls nextval) is refused by Postgres (25006) and leaves no row, where
 *    the insert outside it writes;
 *  - the same under asSystem with a reason the narrow system route takes
 *    ('admin-area', 'audit-log'): the transaction reads
 *    transaction_read_only on, as the narrow role while
 *    MANTLE_NARROW_SYSTEM is on, and a definer that inserts is refused
 *    (25006);
 *  - every statement runCorpusAudit sends goes after the SET TRANSACTION
 *    READ ONLY of its transaction, on its connection (the system pool's
 *    sends, recorded): an audit that ran a check outside
 *    readOnlyTransaction fails here.
 *
 * Makes no table or sequence (a relation dropped while another file runs
 * GRANT ... ON ALL TABLES fails that file): the writers use entities and an
 * existing sequence. Makes its own functions (unique names), drops them
 * and its rows after.
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
  const written = `${tag} written`;
  const insertFn = `${tag}_insert`;
  const nextFn = `${tag}_next`;
  /** Inserts as its owner (the superuser), so only READ ONLY stops it on
   *  the narrow route, whose role may not insert. */
  const definerFn = `${tag}_definer`;

  const su = async (q: string) => (await import('@mantle/db/test-support')).superuserExec(URL!, q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    sql = (m.systemDb as unknown as { $client: import('postgres').Sql }).$client;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    anchor = await ensureTestAnchor(sql);
    // A real pg-boss schema: the queue checks read pgboss.job.
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss({ connectionString: URL!, schema: 'pgboss' });
    await boss.start();
    await boss.stop({ graceful: false, timeout: 5_000 });
    await su(
      `create function public.${insertFn}() returns int language sql
         as $f$ insert into public.entities (owner_id, kind, name)
                values ('${anchor}'::uuid, 'org', '${written}') returning 1 $f$`,
    );
    await su(
      `create function public.${nextFn}() returns bigint language sql
         as $f$ select nextval('public.heads_check_misses_id_seq') $f$`,
    );
    await su(
      `create function public.${definerFn}() returns int language sql security definer
         set search_path = pg_catalog, public
         as $f$ insert into public.entities (owner_id, kind, name)
                values ('${anchor}'::uuid, 'org', '${written}') returning 1 $f$`,
    );
    await su(`grant execute on function public.${definerFn}() to public`);
  }, 60_000);

  afterAll(async () => {
    if (anchor) {
      await su(`drop function if exists public.${insertFn}()`);
      await su(`drop function if exists public.${nextFn}()`);
      await su(`drop function if exists public.${definerFn}()`);
      await sql`delete from entities where owner_id = ${anchor} and name = ${written}`;
    }
    await m?.closeDb();
  });

  const rowsIn = async () =>
    Number((await sql`select count(*)::int as n from entities where name = ${written}`)[0]!.n);

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

  it('sends every statement of the audit inside its read-only transaction', async () => {
    const { recordSystemPoolSends, sentReadOnly } = await import('@mantle/db/test-support');
    const { runCorpusAudit } = await import('./audit');
    const rec = recordSystemPoolSends();
    let checks: number;
    try {
      checks = (await runCorpusAudit(anchor)).checks.length;
    } finally {
      rec.stop();
    }
    // The audit's own statements: not the transaction's control, nor the
    // actor's or the narrow route's tagged statements (a mode read on
    // another connection may land in the window).
    const own = rec.sent
      .map((x, i) => ({ ...x, i }))
      .filter(
        (x) =>
          !/^\s*\/\*\s*mantle:/.test(x.text) &&
          !/^\s*(?:begin|commit|rollback|set\s+transaction)\b/i.test(x.text),
      );
    expect(checks).toBeGreaterThan(0);
    expect(own.length).toBeGreaterThanOrEqual(checks);
    for (const x of own) expect(sentReadOnly(rec.sent, x.i), x.text.slice(0, 120)).toBe(true);
  }, 120_000);

  for (const reason of ['admin-area', 'audit-log'] as const) {
    it(`is read only under asSystem('${reason}'), the narrow route`, async () => {
      const row = await m.asSystem(
        () =>
          m.readOnlyTransaction(async (tx) => {
            const r = (await tx.execute(
              sqlTag`select current_setting('transaction_read_only') as ro, current_user as u`,
            )) as unknown as { ro: string; u: string }[];
            return r[0]!;
          }),
        reason,
      );
      expect(row.ro).toBe('on');
      // The narrow route is on unless the run turns it off.
      if (process.env.MANTLE_NARROW_SYSTEM === undefined)
        expect(row.u).toBe('mantle_system_narrow');
      const text = `select public.${definerFn}() as x`;
      const err = await m
        .asSystem(
          () => m.readOnlyTransaction((tx) => tx.execute(sqlTag.raw(m.readSql(text)))),
          reason,
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(codeOf(err), String(err)).toBe('25006');
      expect(await rowsIn()).toBe(0);
    });
  }

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
