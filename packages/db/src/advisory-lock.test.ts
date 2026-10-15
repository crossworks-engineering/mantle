import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { advisoryXactLock, tryAdvisoryXactLock, type AdvisoryLockExec } from './advisory-lock';

/** The query a lock sends, rendered as Postgres receives it. */
async function sent(take: (tx: AdvisoryLockExec) => Promise<unknown>) {
  const out: Array<{ sql: string; params: unknown[] }> = [];
  const dialect = new PgDialect();
  await take({
    execute: async (q) => {
      const { sql, params } = dialect.sqlToQuery(q);
      out.push({ sql, params });
      return [{ locked: true }];
    },
  });
  return out;
}

describe('advisory locks (A10 #15): the SQL main wrote by hand', () => {
  it('hashtextextended: pg_advisory_xact_lock(hashtextextended($1, 0))', async () => {
    expect(await sent((tx) => advisoryXactLock(tx, 'node-seq:n1', 'hashtextextended'))).toEqual([
      { sql: 'select pg_advisory_xact_lock(hashtextextended($1, 0))', params: ['node-seq:n1'] },
    ]);
  });
  it('hashtext: pg_advisory_xact_lock(hashtext($1))', async () => {
    expect(await sent((tx) => advisoryXactLock(tx, 'oauth-actor:a1', 'hashtext'))).toEqual([
      { sql: 'select pg_advisory_xact_lock(hashtext($1))', params: ['oauth-actor:a1'] },
    ]);
  });
  it('try: pg_try_advisory_xact_lock(...) as locked, read as a boolean', async () => {
    let got: boolean | null = null;
    expect(
      await sent(async (tx) => {
        got = await tryAdvisoryXactLock(tx, 'mantle:maintenance:entities-dedupe', 'hashtext');
      }),
    ).toEqual([
      {
        sql: 'select pg_try_advisory_xact_lock(hashtext($1)) as locked',
        params: ['mantle:maintenance:entities-dedupe'],
      },
    ]);
    expect(got).toBe(true);
    expect(
      await tryAdvisoryXactLock({ execute: async () => [{ locked: false }] }, 'k', 'hashtext'),
    ).toBe(false);
    expect(
      await tryAdvisoryXactLock(
        { execute: async () => ({ rows: [{ locked: true }] }) },
        'k',
        'hashtext',
      ),
    ).toBe(true);
  });
});
