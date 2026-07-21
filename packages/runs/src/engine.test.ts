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
import { eq, sql } from 'drizzle-orm';
import { runItems, runs, type Db } from '@mantle/db';

import {
  appendChildren,
  cancelRun,
  claimItem,
  claimWorkerItem,
  completeItem,
  createRun,
  requeueForRetry,
  SealedGroupError,
  type PlanGroup,
  type PostCommitAction,
} from './engine';
import { claimResume, sweepRuns } from './sweep';
import { applyAuditVerdict, mechanicalPreCheck } from './audit';

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
    for (const file of ['0129_runs.sql', '0130_runs_resume_marker.sql']) {
      const migration = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations/', file),
        'utf8',
      );
      for (const stmt of migration.split('--> statement-breakpoint')) {
        const s = stmt.trim();
        // The scratch db has no trace_kind enum (0130's ALTER TYPE belongs to
        // the full schema) — the engine tables are what these tests exercise.
        if (s && !s.startsWith('ALTER TYPE')) await client.unsafe(s);
      }
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

  it('sweep: overdue running item fails(timeout) and drives the counter', SLOW, async () => {
    const { runId, rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'sweep timeout',
      plan: { kind: 'par', children: [note('slow'), note('fine')] },
    });
    const [slow, fine] = await children(rootItemId);
    await claimItem(db, slow!.id);
    // Force the deadline into the past (test scaffolding — promote stamped
    // now()+600s).
    await db
      .update(runItems)
      .set({ deadlineAt: sql`now() - interval '1 minute'` })
      .where(eq(runItems.id, slow!.id));

    const res = await sweepRuns(db);
    expect(res.timedOut).toBeGreaterThanOrEqual(1);
    const swept = await itemRow(slow!.id);
    expect(swept.state).toBe('failed');
    expect(swept.result?.failure).toMatchObject({ type: 'timeout' });
    expect((await itemRow(rootItemId)).childrenDone).toBe(1);

    // The sibling completes normally → group failed (wait_all), exactly one
    // resume for THIS run across sweep + completion.
    const r2 = await completeItem(db, { itemId: fine!.id, state: 'done' });
    expect(
      [...res.actions, ...r2.actions].filter((a) => a.type === 'resume' && a.runId === runId),
    ).toHaveLength(1);
    expect((await runRow(runId)).status).toBe('failed');
  });

  it('sweep: stale ready item is re-dispatched (lost-job heal)', SLOW, async () => {
    const { rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'sweep redispatch',
      plan: { kind: 'par', children: [note('lost')] },
    });
    const [lost] = await children(rootItemId);
    await db
      .update(runItems)
      .set({ updatedAt: sql`now() - interval '5 minutes'` })
      .where(eq(runItems.id, lost!.id));

    const res = await sweepRuns(db);
    const redispatch = res.actions.filter((a) => a.type === 'dispatch' && a.itemId === lost!.id);
    expect(redispatch).toHaveLength(1);
    // The re-emitted wake-up claims normally.
    expect(await claimItem(db, lost!.id)).not.toBeNull();
    // And the touch means an immediate second sweep does NOT re-emit.
    const res2 = await sweepRuns(db);
    expect(res2.actions.filter((a) => a.type === 'dispatch' && a.itemId === lost!.id)).toHaveLength(
      0,
    );
  });

  it('sweep: lost resume is re-sent; claimResume is exactly-once', SLOW, async () => {
    const { runId, rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'sweep resume heal',
      plan: { kind: 'par', children: [note('a')] },
    });
    const [a] = await children(rootItemId);
    const done = await completeItem(db, { itemId: a!.id, state: 'done' });
    expect(resumes(done)).toHaveLength(1); // the original resume — pretend it was lost

    // Assertions scoped to THIS run — other tests' runs may be stale too.
    const resumesForThisRun = (actions: PostCommitAction[]) =>
      actions.filter((x) => x.type === 'resume' && x.runId === runId);

    // Fresh completion: not yet stale → no re-send for this run.
    expect(resumesForThisRun((await sweepRuns(db)).actions)).toHaveLength(0);
    await db
      .update(runItems)
      .set({ finishedAt: sql`now() - interval '5 minutes'` })
      .where(eq(runItems.id, rootItemId));
    const res = await sweepRuns(db);
    expect(resumesForThisRun(res.actions)).toEqual([
      { type: 'resume', runId, groupId: rootItemId },
    ]);

    // The handler's gate: first claim wins, duplicates no-op forever after.
    expect(await claimResume(db, rootItemId)).toBe(true);
    expect(await claimResume(db, rootItemId)).toBe(false);
    expect(resumesForThisRun((await sweepRuns(db)).actions)).toHaveLength(0);
  });

  it(
    'requeueForRetry: running → ready with attempt bumped; no-op when not running',
    SLOW,
    async () => {
      const { rootItemId } = await createRun(db, {
        ownerId: OWNER,
        title: 'retry',
        plan: { kind: 'par', children: [note('flaky'), note('other')] },
      });
      const [flaky] = await children(rootItemId);
      await claimItem(db, flaky!.id);
      const action = await requeueForRetry(db, flaky!.id);
      expect(action).toMatchObject({ type: 'dispatch', itemId: flaky!.id });
      const row = await itemRow(flaky!.id);
      expect(row.state).toBe('ready');
      expect(row.attempt).toBe(1);
      expect((await itemRow(rootItemId)).childrenDone).toBe(0); // retry is not a completion
      // Not running anymore → retry loses.
      expect(await requeueForRetry(db, flaky!.id)).toBeNull();
    },
  );

  it(
    'lock ordering: fail_fast cancellation racing a sibling completion never deadlocks',
    { timeout: 120_000 },
    async () => {
      // Audit 2026-07-21: completion locked child→parent while fail_fast
      // cancellation locked parent→subtree — opposite orders, PG deadlock
      // (40P01). The run-row-first ordering rule serializes them. Both
      // children are RUNNING (a queued sibling reproduces nothing — it is
      // locked by nobody).
      for (let round = 0; round < 12; round++) {
        const { runId, rootItemId } = await createRun(db, {
          ownerId: OWNER,
          title: `fail_fast race ${round}`,
          plan: { kind: 'par', joinPolicy: 'fail_fast', children: [note('boom'), note('slow')] },
        });
        const [boom, slow] = await children(rootItemId);
        await claimItem(db, boom!.id);
        await claimItem(db, slow!.id);
        // One child fails (fail_fast wants to cancel the running sibling)
        // while that sibling completes — genuinely concurrent transactions.
        const [rFail, rDone] = await Promise.all([
          completeItem(db, {
            itemId: boom!.id,
            state: 'failed',
            failure: { type: 'tool_error', message: 'synthetic' },
          }),
          completeItem(db, { itemId: slow!.id, state: 'done' }),
        ]);
        // Whichever serializes second must NOT deadlock. Two legal outcomes:
        // the completion wins the run lock (both complete, summary counts a
        // done), or the failure wins and its fail_fast cancel takes the
        // sibling first (the completion no-ops at its CAS). Exactly one
        // resume and a coherent failed group either way.
        expect(rFail.completed).toBe(true);
        expect(resumes(rFail, rDone)).toHaveLength(1);
        const root = await itemRow(rootItemId);
        expect(root.state).toBe('failed');
        expect(root.childrenDone).toBe(2);
        if (!rDone.completed) {
          expect((await itemRow(slow!.id)).state).toBe('cancelled');
        }
        expect((await runRow(runId)).status).toBe('failed');
      }
    },
  );

  it(
    'lock ordering: cancelRun racing an in-flight completion never deadlocks',
    { timeout: 120_000 },
    async () => {
      for (let round = 0; round < 12; round++) {
        const { runId, rootItemId } = await createRun(db, {
          ownerId: OWNER,
          title: `cancel race ${round}`,
          plan: { kind: 'par', children: [note('a'), note('b')] },
        });
        const [a, b] = await children(rootItemId);
        await claimItem(db, a!.id);
        await claimItem(db, b!.id);
        const [rCancel, rDone] = await Promise.all([
          cancelRun(db, runId),
          completeItem(db, { itemId: a!.id, state: 'done' }),
        ]);
        expect(rCancel.cancelled).toBe(true);
        // The completion either won the race (completed) or lost to the
        // cancel (no-op) — both legal; a deadlock throw is the failure mode.
        expect((await runRow(runId)).status).toBe('cancelled');
        expect(resumes(rDone)).toHaveLength(0);
        expect((await itemRow(b!.id)).state).toBe('cancelled');
      }
    },
  );

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

  // ── slice 2: workers + audits ──────────────────────────────────────────────

  it('audit promotion emits a resume action, not a dispatch', SLOW, async () => {
    const { runId, rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'audit promote',
      plan: { kind: 'seq', children: [note('work'), { kind: 'audit', payload: {} }] },
    });
    const [work, audit] = await children(rootItemId);
    const r = await completeItem(db, { itemId: work!.id, state: 'done' });
    expect(dispatches(r)).toHaveLength(0);
    expect(resumes(r)).toEqual([{ type: 'resume', runId, groupId: audit!.id }]);
    const auditRow = await itemRow(audit!.id);
    expect(auditRow.state).toBe('ready');
    expect(auditRow.deadlineAt).not.toBeNull(); // verdict budget stamps at promote
  });

  it('applyAuditVerdict pass completes the audit and the run', SLOW, async () => {
    const { runId, rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'audit pass',
      plan: {
        kind: 'seq',
        children: [
          { kind: 'worker_invoke', payload: { step: 'draft the thing' } },
          { kind: 'audit', payload: {} },
        ],
      },
    });
    const [worker, audit] = await children(rootItemId);
    await completeItem(db, {
      itemId: worker!.id,
      state: 'done',
      result: { proposal: 'a draft', evidence: [{ tool: 'search_nodes', ok: true }] },
    });
    const res = await applyAuditVerdict(db, {
      auditItemId: audit!.id,
      verdict: 'pass',
      findings: [{ severity: 'advisory', claim: 'could cite one more source' }],
    });
    expect(res.ok && res.outcome).toBe('pass');
    if (!res.ok) throw new Error('unreachable');
    expect(res.actions.filter((a) => a.type === 'resume' && a.runId === runId)).toHaveLength(1);
    expect((await itemRow(audit!.id)).state).toBe('done');
    expect((await runRow(runId)).status).toBe('done');
  });

  it('verdict coherence: redo needs blocking; pass refuses blocking', SLOW, async () => {
    const { rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'audit coherence',
      plan: {
        kind: 'seq',
        children: [
          { kind: 'worker_invoke', payload: { step: 's' } },
          { kind: 'audit', payload: {} },
        ],
      },
    });
    const [worker, audit] = await children(rootItemId);
    await completeItem(db, { itemId: worker!.id, state: 'done', result: { proposal: 'p' } });
    const redoNoBlocking = await applyAuditVerdict(db, {
      auditItemId: audit!.id,
      verdict: 'redo',
      findings: [{ severity: 'advisory', claim: 'meh' }],
    });
    expect(redoNoBlocking.ok).toBe(false);
    const passWithBlocking = await applyAuditVerdict(db, {
      auditItemId: audit!.id,
      verdict: 'pass',
      findings: [{ severity: 'blocking', claim: 'wrong' }],
    });
    expect(passWithBlocking.ok).toBe(false);
    // Audit still pending after both refusals.
    expect((await itemRow(audit!.id)).state).toBe('ready');
  });

  it('redo cycle: supersede + append + promote; second blocking → needs_human', SLOW, async () => {
    const { runId, rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'redo cycle',
      plan: {
        kind: 'seq',
        children: [
          { kind: 'worker_invoke', payload: { step: 'write the summary' } },
          { kind: 'audit', payload: {} },
        ],
      },
    });
    const [worker1, audit1] = await children(rootItemId);
    await completeItem(db, {
      itemId: worker1!.id,
      state: 'done',
      result: { proposal: 'I verified everything.', evidence: [] },
    });

    // Redo: worker1 superseded, replacement + fresh audit appended, replacement dispatched.
    const redo = await applyAuditVerdict(db, {
      auditItemId: audit1!.id,
      verdict: 'redo',
      findings: [{ severity: 'blocking', claim: 'claims verification with an empty ledger' }],
      directive: 'actually read the sources before summarizing',
    });
    expect(redo.ok && redo.outcome).toBe('redo');
    if (!redo.ok || !redo.replacementItemId) throw new Error('unreachable');
    const w1 = await itemRow(worker1!.id);
    expect(w1.state).toBe('superseded');
    expect(w1.supersededBy).toBe(redo.replacementItemId);
    const root1 = await itemRow(rootItemId);
    expect(root1.childrenTotal).toBe(4);
    expect(root1.state).toBe('running'); // two appended children still pending
    const replacement = await itemRow(redo.replacementItemId);
    expect(replacement.state).toBe('ready'); // seq promoted it after the audit completed
    const rp = replacement.payload as Record<string, unknown>;
    expect(rp.redo_of).toBe(worker1!.id);
    expect(Array.isArray(rp.audit_findings)).toBe(true);
    expect(
      redo.actions.filter((a) => a.type === 'dispatch' && a.itemId === redo.replacementItemId),
    ).toHaveLength(1);

    // Replacement completes → the fresh audit resumes.
    const r2 = await completeItem(db, {
      itemId: redo.replacementItemId,
      state: 'done',
      result: { proposal: 'better', evidence: [{ tool: 'search_nodes', ok: true }] },
    });
    const kidsNow = await children(rootItemId);
    const audit2 = kidsNow[3]!;
    expect(audit2.kind).toBe('audit');
    expect(resumes(r2)).toEqual([{ type: 'resume', runId, groupId: audit2.id }]);

    // Second blocking verdict → redo cap → needs_human; the run completes failed.
    const second = await applyAuditVerdict(db, {
      auditItemId: audit2.id,
      verdict: 'redo',
      findings: [{ severity: 'blocking', claim: 'still wrong' }],
    });
    expect(second.ok && second.outcome).toBe('needs_human');
    if (!second.ok) throw new Error('unreachable');
    expect((await itemRow(audit2.id)).state).toBe('failed');
    expect((await itemRow(audit2.id)).result?.failure).toMatchObject({ type: 'needs_human' });
    expect((await runRow(runId)).status).toBe('failed');
    expect(second.actions.filter((a) => a.type === 'resume' && a.runId === runId)).toHaveLength(1);
    // Counter integrity: 4 children, all terminal, counted exactly once each.
    expect((await itemRow(rootItemId)).childrenDone).toBe(4);
  });

  it('mechanicalPreCheck flags verification claims with an empty ledger', () => {
    expect(
      mechanicalPreCheck({ proposal: 'I verified the totals against the ledger.', evidence: [] })
        .length,
    ).toBeGreaterThan(0);
    expect(
      mechanicalPreCheck({
        proposal: 'I verified the totals.',
        evidence: [{ tool: 'table_query', ok: true }],
      }),
    ).toHaveLength(0);
    expect(
      mechanicalPreCheck({
        proposal: 'summary attached',
        evidence: [{ tool: 'search_nodes', ok: false }],
      })[0],
    ).toMatch(/FAILED/);
  });

  it('claimWorkerItem enforces the per-run cap; completion frees a slot', SLOW, async () => {
    const { rootItemId } = await createRun(db, {
      ownerId: OWNER,
      title: 'worker cap',
      plan: {
        kind: 'par',
        children: Array.from({ length: 4 }, (_, i) => ({
          kind: 'worker_invoke' as const,
          payload: { step: `s${i}` },
        })),
      },
    });
    const kids = await children(rootItemId);
    const c1 = await claimWorkerItem(db, kids[0]!.id, 2);
    const c2 = await claimWorkerItem(db, kids[1]!.id, 2);
    expect(c1.item).not.toBeNull();
    expect(c2.item).not.toBeNull();
    const c3 = await claimWorkerItem(db, kids[2]!.id, 2);
    expect(c3.item).toBeNull();
    expect(c3.capped).toBe(true);
    // Duplicate wake-up of a RUNNING item: stale, not capped.
    const dup = await claimWorkerItem(db, kids[0]!.id, 2);
    expect(dup.item).toBeNull();
    expect(dup.capped).toBeUndefined();

    // A completion frees a slot AND emits wake-ups for the waiting items.
    const done = await completeItem(db, { itemId: kids[0]!.id, state: 'done' });
    const releases = done.actions.filter(
      (a) => a.type === 'dispatch' && a.queue === 'mantle.run.worker',
    );
    expect(releases.length).toBeGreaterThan(0);
    const c3b = await claimWorkerItem(db, kids[2]!.id, 2);
    expect(c3b.item).not.toBeNull();
  });
});
