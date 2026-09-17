/**
 * `upsertExternalEvent` and the insert race.
 *
 * The function reads then writes: SELECT the event node for (owner, account,
 * uid), UPDATE it if found, INSERT if not. Calendar sync is exactly the
 * workload that runs that concurrently — a scheduled sync overlapping a manual
 * one, or a retried job — so both callers can miss the row and both insert.
 * Until migration 0155 there was no constraint to stop them, and the result was
 * permanent: the same meeting twice in the calendar, embedded twice, answering
 * twice in retrieval, with an upstream feed that still holds exactly one.
 *
 * The index makes the second insert impossible. What these tests cover is the
 * half the index cannot do on its own — that losing the race produces the RIGHT
 * ANSWER rather than a failed sync, and that a retry which still cannot find
 * the row is reported instead of spun on.
 *
 * The db is stubbed at the three shapes this function uses (select chain,
 * update chain, insert chain); the branching, the merge and the retry are real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every row the db hands back carries these; rowOf() calls toISOString. */
const stamps = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

const h = vi.hoisted(() => ({
  /** Rows each SELECT returns, in call order; falls back to `selectRows` once
   *  drained. A QUEUE rather than a per-test mockImplementation because
   *  `clearAllMocks` clears CALLS, not implementations — a replaced select
   *  leaked into the two tests after it and quietly made them pass the wrong
   *  branch. */
  selectQueue: [] as unknown[][],
  /** Rows a SELECT returns once the queue is drained. */
  selectRows: [] as unknown[],
  /** Rows the next INSERT ... ON CONFLICT DO NOTHING returns; [] = it lost. */
  insertRows: [] as unknown[],
  updates: [] as Record<string, unknown>[],
  inserted: [] as Record<string, unknown>[],
  conflictClauses: 0,
  notified: [] as string[],
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const db = {
    ...actual.db,
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(async () => (h.selectQueue.length ? h.selectQueue.shift()! : h.selectRows)),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        h.updates.push(patch);
        return {
          where: vi.fn(() => ({
            returning: async () => [
              { ...stamps, id: 'existing', data: patch.data, title: patch.title, tags: [] },
            ],
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        // Every call also runs ensureRoot, which inserts the `branch` node for
        // the events root under its own conflict clause. Ignore it here or it
        // doubles every count these tests are about.
        const isEventsRoot = row.type === 'branch';
        if (!isEventsRoot) h.inserted.push(row);
        return {
          onConflictDoNothing: vi.fn(() => {
            if (!isEventsRoot) h.conflictClauses++;
            return { returning: async () => h.insertRows };
          }),
        };
      }),
    })),
  };
  return {
    ...actual,
    db,
    notifyNodeIngested: vi.fn(async (id: string) => void h.notified.push(id)),
  };
});
import { upsertExternalEvent } from './events';

const INPUT = {
  externalAccountId: 'acct-1',
  externalUid: 'uid-abc',
  externalSource: 'ics',
  title: 'Standup',
  startsAt: '2026-09-10T09:00:00.000Z',
};

/** A stored node as the SELECT returns it. */
const stored = (over: Record<string, unknown> = {}) => ({
  ...stamps,
  id: 'existing',
  ownerId: 'o1',
  type: 'event',
  title: 'Standup',
  tags: [],
  data: {
    // `body` is always written on insert (description ?? ''), so a fixture
    // without it reads as a content change and no-op detection never fires.
    body: '',
    starts_at: '2026-09-10T09:00:00.000Z',
    external_uid: 'uid-abc',
    external_account_id: 'acct-1',
    external_source: 'ics',
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.selectRows = [];
  h.insertRows = [
    { ...stamps, id: 'fresh', ownerId: 'o1', type: 'event', title: 'Standup', data: {}, tags: [] },
  ];
  h.updates.length = 0;
  h.inserted.length = 0;
  h.conflictClauses = 0;
  h.notified.length = 0;
});

describe('upsertExternalEvent', () => {
  it('inserts under a conflict clause, so a concurrent insert cannot duplicate', async () => {
    await upsertExternalEvent('o1', INPUT);
    // Without this the unique index turns a lost race into a failed sync.
    expect(h.conflictClauses).toBe(1);
    expect(h.inserted[0]).toMatchObject({ ownerId: 'o1', type: 'event', title: 'Standup' });
  });

  it('LOST RACE: re-runs once and takes the update path on the winner’s row', async () => {
    // First pass: nothing found, insert returns nothing (the other sync won).
    // Second pass: the SELECT now sees their row, with content that differs.
    h.insertRows = [];
    h.selectQueue.push([], [stored({ title: 'Old title' })]);

    const res = await upsertExternalEvent('o1', INPUT);
    // One insert attempt, then the retry resolved through UPDATE — not a throw,
    // and not a second insert.
    expect(h.inserted).toHaveLength(1);
    expect(h.updates).toHaveLength(1);
    expect(res.title).toBe('Standup');
    // The update path owns the notify, because ON CONFLICT DO NOTHING fires no
    // insert trigger and the row is left with a null embedding.
    expect(h.notified).toEqual(['existing']);
  });

  it('LOST RACE then still missing: reports rather than spinning', async () => {
    // The index says a row exists; the lookup says it does not. That is a real
    // disagreement, and looping on it would hide it forever.
    h.insertRows = [];
    await expect(upsertExternalEvent('o1', INPUT)).rejects.toThrow(
      /the unique index and the lookup disagree/,
    );
    // Exactly two attempts — the original and the one retry.
    expect(h.inserted).toHaveLength(2);
  });

  it('no-ops a re-sync that changed nothing, so a poll does not churn the brain', async () => {
    h.selectRows = [stored()];
    await upsertExternalEvent('o1', INPUT);
    expect(h.updates).toEqual([]);
    expect(h.inserted).toEqual([]);
    expect(h.notified).toEqual([]);
  });

  it('drops stale extractor output when the content really changed', async () => {
    h.selectRows = [
      stored({ title: 'Old title', data: { ...stored().data, summary: 's', entities: ['x'] } }),
    ];
    await upsertExternalEvent('o1', INPUT);
    const patch = h.updates[0]!;
    const data = patch.data as Record<string, unknown>;
    // The summary described the OLD event; keeping it would leave the brain
    // answering from a meeting that moved.
    expect(data).not.toHaveProperty('summary');
    expect(data).not.toHaveProperty('entities');
    expect(patch.embedding).toBeNull();
    expect(h.notified).toEqual(['existing']);
  });
});
