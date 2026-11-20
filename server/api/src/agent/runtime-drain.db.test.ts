/**
 * The extractor's recovery drain (runtime.ts drainUnextractedNodes) on a
 * real, migrated scratch Postgres: a node with no embedding is queued for
 * its extract, but a node that already has a live read (created, retry or
 * active, any lane) is left to it, so a recovery never makes a second job
 * of the same work. An Agent's run or deferred facts are no read. The queue is stood in for (enqueueExtract records),
 * and pg-boss's job table is a stand-in with the columns read.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/runtime-drain.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ queued: [] as string[] }));
vi.mock('./extract-queue.js', async (orig) => ({
  ...(await orig<typeof import('./extract-queue')>()),
  enqueueExtract: vi.fn(async (nodeId: string) => {
    h.queued.push(nodeId);
  }),
}));

describe.skipIf(!URL)('the recovery drain', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']>;
  let m: typeof import('@mantle/db');
  let runtime: typeof import('./runtime');
  let owner = '';

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    su = ts.superuserClient(scratch.url);
    owner = await ts.ensureTestAnchor(su);
    const [reg] = await su<{ ok: boolean }[]>`select to_regclass('pgboss.job') is not null as ok`;
    if (!reg?.ok) {
      await su`create schema if not exists pgboss`;
      await su`create table pgboss.job (name text not null, state text not null,
        data jsonb, start_after timestamptz not null default now())`;
      await su`grant usage on schema pgboss to mantle_system_narrow, mantle_runtime`;
      await su`grant select on pgboss.job to mantle_system_narrow, mantle_runtime`;
    }
    m = await import('@mantle/db');
    runtime = await import('./runtime');
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  }, 60_000);

  it('queues a node with no job, and leaves each node with a live job to it', async () => {
    const file = async (name: string) => {
      const id = randomUUID();
      await su`insert into nodes (id, owner_id, type, title, path, data)
        values (${id}, ${owner}, 'file', ${name}, 'files', jsonb_build_object('filename', ${name}::text))`;
      return id;
    };
    const none = await file('no-job.pdf');
    const live: Record<string, string> = {};
    for (const [state, lane] of [
      ['created', 'mantle.extract'],
      ['retry', 'mantle.extract.heavy'],
      ['active', 'mantle.extract.book'],
    ] as const) {
      const id = await file(`${state}.pdf`);
      live[state] = id;
      // Built in SQL: a JSON text bound as a parameter lands as one jsonb
      // string, with no keys to read.
      await su`insert into pgboss.job (name, state, data)
        values (${lane}, ${state},
                jsonb_build_object('nodeId', ${id}::text, 'wait', jsonb_build_object('waits', 2)))`;
    }
    // An Agent's run or deferred facts are no read: the node is queued.
    const others: string[] = [];
    for (const key of ['run', 'facts'] as const) {
      const id = await file(`${key}-only.pdf`);
      others.push(id);
      await su`insert into pgboss.job (name, state, data)
        values ('mantle.extract', 'created',
                jsonb_build_object('nodeId', ${id}::text, ${key}::text, 'x'))`;
    }
    // A job that ended is no live job: the node is queued again.
    const ended = await file('ended.pdf');
    await su`insert into pgboss.job (name, state, data)
      values ('mantle.extract', 'completed', jsonb_build_object('nodeId', ${ended}::text))`;

    // The stand-in is the queue the drain reads.
    const seen = await m.runAsSystem('test:drain', () => m.extractJobsFor(Object.values(live)));
    expect(seen.size).toBe(3);
    await m.runAsSystem('test:drain', () => runtime.drainUnextractedNodes(owner));
    expect(h.queued.sort()).toEqual([none, ended, ...others].sort());
    for (const id of Object.values(live)) expect(h.queued).not.toContain(id);
  }, 60_000);
});
