/**
 * DB-backed engine tests — the slice-1 acceptance battery, headlined by the
 * critical one: N children completing in genuinely parallel transactions
 * produce EXACTLY ONE resume (the resume-storm invariant).
 *
 * Gated on RUNS_TEST_DATABASE_URL — a Postgres URL whose role can CREATE
 * DATABASE (the compose superuser qualifies). The suite drops + creates a
 * scratch database `mantle_runs_engine_test`, applies migration 0129 there,
 * and drops it again afterwards; the URL's own database is never written.
 * Without the env var the suite skips (CI has no Postgres).
 *
 *   RUNS_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runItems, runs, type Db } from '@mantle/db';

import {
  appendChildren,
  cancelRun,
  claimItem,
  completeItem,
  createRun,
  SealedGroupError,
  type PlanGroup,
  type PostCommitAction,
} from './engine';

const ADMIN_URL = process.env.RUNS_TEST_DATABASE_URL;
const SCRATCH_DB = 'mantle_runs_engine_test';

const OWNER = '00000000-0000-4000-8000-000000000001';

/** Every statement crosses the network to the scratch Postgres (often an SSH
 *  tunnel to the dev box) — vitest's 5s default is far too tight. */
const SLOW = { timeout: 120_000 };

let admin: postgres.Sql;
let client: postgres.Sql;
let db: Db;

function scratchUrl(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${SCRATCH_DB}`;
  return u.toString();
}

function note(text: string) {
  return { kind: 'note' as const, payload: { text } };
}

function resumes(...results: Array<{ actions: PostCommitAction[] }>) {
  return results.flatMap((r) => r.actions).filter((a) => a.type === 'resume');
}

function dispatches(...results: Array<{ actions: PostCommitAction[] }>) {
  return results.flatMap((r) => r.actions).filter((a) => a.type === 'dispatch');
}

async function itemRow(id: string) {
  const [row] = await db.select().from(runItems).where(eq(runItems.id, id));
  return row!;
}

async function runRow(id: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row!;
}

/** Children of a group ordered by position. */
async function children(groupId: string) {
  const rows = await db.select().from(runItems).where(eq(runItems.parentId, groupId));
  return rows.sort((a, b) => a.position - b.position);
}

describe.skipIf(!ADMIN_URL)('runs engine (DB-backed)', () => {
  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, prepare: false });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);

    client = postgres(scratchUrl(ADMIN_URL!), { max: 10, prepare: false });
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations/0129_runs.sql'),
      'utf8',
    );
    for (const stmt of migration.split('--> statement-breakpoint')) {
      const s = stmt.trim();
      if (s) await client.unsafe(s);
    }
    db = drizzle(client) as unknown as Db;
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    if (admin) {
      // Best-effort: FORCE-terminating our own just-closed backends can race;
      // a leftover scratch db is harmless — the next run drops it first.
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });

  // ── THE critical test ──────────────────────────────────────────────────────
  it(
    'parallel child completions produce exactly one resume (2-wide, repeated)',
    { timeout: 120_000 },
    async () => {
      for (let round = 0; round < 12; round++) {
        const { runId, rootItemId, actions } = await createRun(db, {
          ownerId: OWNER,
          title: `race ${round}`,
          plan: { kind: 'par', children: [note('a'), note('b')] },
        });
        expect(dispatches({ actions })).toHaveLength(2);
        const kids = await children(rootItemId);
        for (const k of kids) expect(await claimItem(db, k.id)).not.toBeNull();

        // Two transactions completing sibling children at the same instant —
        // the parent-row lock must serialize them and exactly one may resume.
        const results = await Promise.all(
          kids.map((k) => completeItem(db, { itemId: k.id, state: 'done' })),
        );
        expect(results.every((r) => r.completed)).toBe(true);
        expect(resumes(...results)).toHaveLength(1);

        const root = await itemRow(rootItemId);
        expect(root.state).toBe('done');
        expect(root.sealed).toBe(true);
        expect(root.childrenDone).toBe(2);
        expect((await runRow(runId)).status).toBe('done');
      }
    },
  );

  it('parallel completions, 8-wide: still exactly one resume', { timeout: 60_000 }, async () => {
    const width = 8;
    const { runId, rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'wide race',
      plan: { kind: 'par', children: Array.from({ length: width }, (_, i) => note(`c${i}`)) },
    });
    const kids = await children(rootItemId);
    const results = await Promise.all(
      kids.map((k) => completeItem(db, { itemId: k.id, state: 'done' })),
    );
    expect(results.every((r) => r.completed)).toBe(true);
    expect(resumes(...results)).toHaveLength(1);
    expect((await runRow(runId)).status).toBe('done');
  });

  it('duplicate completion is a no-op (CAS guard, counter untouched)', SLOW, async () => {
    const { rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'dup',
      plan: { kind: 'par', children: [note('a'), note('b')] },
    });
    const [a] = await children(rootItemId);
    const first = await completeItem(db, { itemId: a!.id, state: 'done' });
    expect(first.completed).toBe(true);
    const second = await completeItem(db, { itemId: a!.id, state: 'done' });
    expect(second.completed).toBe(false);
    expect(second.actions).toHaveLength(0);
    expect((await itemRow(rootItemId)).childrenDone).toBe(1);
  });

  it('seq chain: each completion promotes the next; last completes the run', SLOW, async () => {
    const { runId, rootItemId, actions } = await createRun(db, {
      ownerId: OWNER,
      title: 'seq',
      plan: { kind: 'seq', children: [note('a'), note('b'), note('c')] },
    });
    const [a, b, c] = await children(rootItemId);
    // Only the first child is dispatched at start.
    expect(dispatches({ actions }).map((d) => d.itemId)).toEqual([a!.id]);
    expect((await itemRow(b!.id)).state).toBe('queued');

    const r1 = await completeItem(db, { itemId: a!.id, state: 'done' });
    expect(dispatches(r1).map((d) => d.itemId)).toEqual([b!.id]);
    expect(resumes(r1)).toHaveLength(0);
    expect((await itemRow(b!.id)).state).toBe('ready');

    const r2 = await completeItem(db, { itemId: b!.id, state: 'done' });
    expect(dispatches(r2).map((d) => d.itemId)).toEqual([c!.id]);

    const r3 = await completeItem(db, { itemId: c!.id, state: 'done' });
    expect(resumes(r3)).toHaveLength(1);
    expect((await runRow(runId)).status).toBe('done');
  });

  it('nested groups bubble exactly once', { timeout: 60_000 }, async () => {
    const plan: PlanGroup = {
      kind: 'seq',
      children: [note('first'), { kind: 'par', children: [note('p1'), note('p2')] }, note('last')],
    };
    const { runId, rootItemId } = await createRun(db, { ownerId: OWNER, title: 'nested', plan });
    const [first, par, last] = await children(rootItemId);

    const r1 = await completeItem(db, { itemId: first!.id, state: 'done' });
    // Completing the first seq child starts the par group → both leaves dispatch.
    expect(dispatches(r1)).toHaveLength(2);
    expect((await itemRow(par!.id)).state).toBe('running');

    const parKids = await children(par!.id);
    const results = await Promise.all(
      parKids.map((k) => completeItem(db, { itemId: k.id, state: 'done' })),
    );
    // Par group completes once → seq promotes 'last'; no resume yet.
    expect(resumes(...results)).toHaveLength(0);
    expect(dispatches(...results).map((d) => d.itemId)).toEqual([last!.id]);
    const parRow = await itemRow(par!.id);
    expect(parRow.state).toBe('done');
    expect(parRow.sealed).toBe(true);

    const r3 = await completeItem(db, { itemId: last!.id, state: 'done' });
    expect(resumes(r3)).toHaveLength(1);
    expect((await runRow(runId)).status).toBe('done');
  });

  it(
    'wait_all: a failed child still completes the group, as failed, one resume',
    SLOW,
    async () => {
      const { runId, rootItemId } = await createRun(db, {
        ownerId: OWNER,
        title: 'wait_all failure',
        plan: { kind: 'par', children: [note('ok'), note('boom')] },
      });
      const [ok, boom] = await children(rootItemId);
      const r1 = await completeItem(db, {
        itemId: boom!.id,
        state: 'failed',
        failure: { type: 'tool_error', message: 'synthetic failure' },
      });
      // wait_all: group keeps waiting for the sibling.
      expect(resumes(r1)).toHaveLength(0);
      const r2 = await completeItem(db, { itemId: ok!.id, state: 'done' });
      expect(resumes(r2)).toHaveLength(1);
      const root = await itemRow(rootItemId);
      expect(root.state).toBe('failed');
      expect(root.result?.summary).toEqual({ done: 1, failed: 1, cancelled: 0 });
      expect((await runRow(runId)).status).toBe('failed');
    },
  );

  it(
    'fail_fast: first failure cancels pending siblings and completes the group',
    SLOW,
    async () => {
      const { runId, rootItemId } = await createRun(db, {
        ownerId: OWNER,
        title: 'fail_fast',
        plan: { kind: 'seq', joinPolicy: 'fail_fast', children: [note('a'), note('b'), note('c')] },
      });
      const [a, b, c] = await children(rootItemId);
      const r = await completeItem(db, {
        itemId: a!.id,
        state: 'failed',
        failure: { type: 'tool_error', message: 'synthetic failure' },
      });
      expect(resumes(r)).toHaveLength(1);
      expect((await itemRow(b!.id)).state).toBe('cancelled');
      expect((await itemRow(c!.id)).state).toBe('cancelled');
      const root = await itemRow(rootItemId);
      expect(root.state).toBe('failed');
      expect(root.childrenDone).toBe(3);
      expect((await runRow(runId)).status).toBe('failed');
    },
  );

  it('append to a sealed group throws; append to a live par group dispatches', SLOW, async () => {
    const { rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'append',
      plan: { kind: 'par', children: [note('a')] },
    });
    // Live append: promoted immediately (par + running).
    const appended = await appendChildren(db, { groupId: rootItemId, children: [note('b')] });
    expect(appended.itemIds).toHaveLength(1);
    expect(dispatches(appended)).toHaveLength(1);
    expect((await itemRow(rootItemId)).childrenTotal).toBe(2);

    const kids = await children(rootItemId);
    const results = await Promise.all(
      kids.map((k) => completeItem(db, { itemId: k.id, state: 'done' })),
    );
    expect(resumes(...results)).toHaveLength(1);

    // Sealed now — appending must fail; the caller starts a new group.
    await expect(
      appendChildren(db, { groupId: rootItemId, children: [note('late')] }),
    ).rejects.toThrow(SealedGroupError);
  });

  it('empty root group completes the run immediately, with its one resume', SLOW, async () => {
    const { runId, actions } = await createRun(db, {
      ownerId: OWNER,
      title: 'empty',
      plan: { kind: 'par', children: [] },
    });
    expect(resumes({ actions })).toHaveLength(1);
    expect((await runRow(runId)).status).toBe('done');
  });

  it('cancelRun cancels the subtree; late completions no-op and never resume', SLOW, async () => {
    const { runId, rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'cancel',
      plan: { kind: 'par', children: [note('a'), note('b')] },
    });
    const kids = await children(rootItemId);
    for (const k of kids) await claimItem(db, k.id);

    expect((await cancelRun(db, runId)).cancelled).toBe(true);
    expect((await cancelRun(db, runId)).cancelled).toBe(false); // idempotent

    for (const k of kids) expect((await itemRow(k.id)).state).toBe('cancelled');
    expect((await itemRow(rootItemId)).state).toBe('cancelled');
    expect((await runRow(runId)).status).toBe('cancelled');

    // An in-flight handler finishing after the cancel: CAS finds a terminal
    // item → no-op, no counter movement, no resume.
    const late = await completeItem(db, { itemId: kids[0]!.id, state: 'done' });
    expect(late.completed).toBe(false);
    expect(late.actions).toHaveLength(0);
  });
});
