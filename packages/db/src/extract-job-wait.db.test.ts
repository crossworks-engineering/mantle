/**
 * A file's job that waits (the extract queue's point 7: the provider's "not
 * now", the Agents' day cap) on a migrated scratch database, with a minimal
 * pgboss.job standing in for pg-boss's own:
 *  - extractJobsFor says `waiting` for a job held until later, `queued` for
 *    one that is due or not held, `running` above both;
 *  - extractJobWaitOf says why and until when, and nothing for a file with
 *    no held job.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/extract-job-wait.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('extract jobs that wait for the provider or the day cap', () => {
  type Ts = typeof import('./test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('./index');
  const held = randomUUID();
  const due = randomUUID();
  const both = randomUUID();
  const run = randomUUID();
  const none = randomUUID();
  const later = new Date(Date.now() + 3_600_000);

  beforeAll(async () => {
    const ts: Ts = await import('./test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    m = await import('./index');
    const su = (q: ReturnType<typeof sql>) => ts.superuserExec(scratch!.url, q);
    await su(sql`create schema if not exists pgboss`);
    await su(sql`create table if not exists pgboss.job (name text not null, state text not null,
      data jsonb, start_after timestamptz not null default now())`);
    await su(sql`grant usage on schema pgboss to mantle_system_narrow, mantle_runtime`);
    await su(sql`grant select on pgboss.job to mantle_system_narrow, mantle_runtime`);
    const wait = (w: Record<string, unknown>) => JSON.stringify(w);
    await su(sql`insert into pgboss.job (name, state, data, start_after) values
      ('mantle.extract', 'created',
        ${wait({ nodeId: held, wait: { for: 'provider', reason: 'quota', waits: 2, until: later.toISOString() } })}::jsonb,
        ${later.toISOString()}::timestamptz),
      ('mantle.extract', 'created',
        ${wait({ nodeId: due, wait: { for: 'provider', reason: 'rate_limit', waits: 0, until: '2026-01-01T00:00:00Z' } })}::jsonb,
        now() - interval '1 minute'),
      ('mantle.extract', 'created',
        ${wait({ nodeId: both, wait: { for: 'provider', reason: 'overloaded', waits: 0, until: later.toISOString() } })}::jsonb,
        ${later.toISOString()}::timestamptz),
      ('mantle.extract', 'active', ${wait({ nodeId: both })}::jsonb, now()),
      ('mantle.extract', 'created',
        ${wait({ nodeId: run, run: 'pdf-page-read', wait: { for: 'day_cap', waits: 0, until: later.toISOString() } })}::jsonb,
        ${later.toISOString()}::timestamptz)`);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('the state of each file: held is waiting, due is queued, running wins', async () => {
    const jobs = await m.extractJobsFor([held, due, both, run, none]);
    expect(jobs.get(held)).toBe('waiting');
    expect(jobs.get(due)).toBe('queued');
    expect(jobs.get(both)).toBe('running');
    expect(jobs.get(run)).toBe('waiting');
    expect(jobs.has(none)).toBe(false);
  });

  it('why it waits and until when', async () => {
    expect(await m.extractJobWaitOf(held)).toEqual({
      for: 'provider',
      reason: 'quota',
      until: later.toISOString(),
    });
    expect(await m.extractJobWaitOf(run)).toEqual({
      for: 'day_cap',
      run: 'pdf-page-read',
      until: later.toISOString(),
    });
    expect(await m.extractJobWaitOf(due)).toBeNull();
    expect(await m.extractJobWaitOf(none)).toBeNull();
  });
});
