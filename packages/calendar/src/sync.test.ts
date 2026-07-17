import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarAccount } from '@mantle/db';
import type { CalendarPull } from './types';

/**
 * The calendar sync orchestrator — the reconcile step that decides which event
 * nodes are upserted and, critically, which are DELETED from the brain. A wrong
 * delete here destroys user calendar data, so both deletion modes are pinned:
 *   - full-set providers (ICS): stored uids absent from this pull are deleted;
 *   - delta providers: only explicit `cancelled` tombstones are deleted, and
 *     absence is NEVER treated as a deletion.
 * Plus: cancelled events are not upserted, sync-state advances correctly, and
 * the calendar tag is slugged onto every event.
 *
 * Seams mocked: the provider (./providers/ics), the content upsert/list/delete
 * helpers (@mantle/content), the db update chain (@mantle/db), and drizzle's eq.
 */

const pull = vi.fn<() => Promise<CalendarPull>>();
vi.mock('./providers/ics', () => ({ icsProvider: { pull: () => pull() } }));

const upsertExternalEvent = vi.fn(async () => ({}) as unknown);
const listExternalEventUids = vi.fn<(o: string, a: string) => Promise<string[]>>(async () => []);
const deleteExternalEvents = vi.fn(async (_o: string, _a: string, uids: string[]) => uids.length);
vi.mock('@mantle/content', () => ({
  upsertExternalEvent: (...a: unknown[]) => upsertExternalEvent(...(a as [])),
  listExternalEventUids: (o: string, a: string) => listExternalEventUids(o, a),
  deleteExternalEvents: (o: string, a: string, u: string[]) => deleteExternalEvents(o, a, u),
}));

const updateSet = vi.fn();
vi.mock('@mantle/db', () => ({
  calendarAccounts: {},
  db: {
    update: () => ({ set: (v: unknown) => (updateSet(v), { where: async () => undefined }) }),
  },
}));

vi.mock('drizzle-orm', async (orig) => ({ ...((await orig()) as object), eq: () => ({}) }));

import { syncCalendarAccount } from './sync';

function account(overrides: Partial<CalendarAccount> = {}): CalendarAccount {
  return {
    id: 'cal-1',
    ownerId: 'owner-1',
    provider: 'ics',
    displayName: 'Work Calendar',
    syncState: {},
    ...overrides,
  } as CalendarAccount;
}

function ev(uid: string, status: 'confirmed' | 'cancelled' = 'confirmed') {
  return { uid, title: uid, startsAt: '2026-06-01T10:00:00.000Z', status };
}

beforeEach(() => {
  pull.mockReset();
  upsertExternalEvent.mockClear();
  listExternalEventUids.mockReset().mockResolvedValue([]);
  deleteExternalEvents.mockClear();
  updateSet.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('syncCalendarAccount — full-set reconciliation (ICS)', () => {
  it('upserts fresh events and deletes stored uids that are absent from this pull', async () => {
    pull.mockResolvedValue({ events: [ev('A'), ev('B')], fullSet: true });
    listExternalEventUids.mockResolvedValue(['A', 'C']); // C vanished upstream

    const res = await syncCalendarAccount(account());

    expect(res).toEqual({ pulled: 2, upserted: 2, removed: 1 });
    expect(upsertExternalEvent).toHaveBeenCalledTimes(2);
    // The ONLY deletion is the vanished uid — never A or B.
    expect(deleteExternalEvents).toHaveBeenCalledWith('owner-1', 'cal-1', ['C']);
  });

  it('deletes an event that turned CANCELLED (skipped on upsert, then removed by absence)', async () => {
    pull.mockResolvedValue({ events: [ev('A'), ev('B', 'cancelled')], fullSet: true });
    listExternalEventUids.mockResolvedValue(['A', 'B']);

    const res = await syncCalendarAccount(account());

    expect(res.upserted).toBe(1); // B (cancelled) not upserted
    expect(upsertExternalEvent).toHaveBeenCalledTimes(1);
    expect(deleteExternalEvents).toHaveBeenCalledWith('owner-1', 'cal-1', ['B']);
    expect(res.removed).toBe(1);
  });

  it('deletes nothing when every stored event is still present (idempotent re-sync)', async () => {
    pull.mockResolvedValue({ events: [ev('A'), ev('B')], fullSet: true });
    listExternalEventUids.mockResolvedValue(['A', 'B']);

    const res = await syncCalendarAccount(account());

    expect(res.removed).toBe(0);
    expect(deleteExternalEvents).toHaveBeenCalledWith('owner-1', 'cal-1', []);
  });
});

describe('syncCalendarAccount — delta reconciliation', () => {
  it('deletes only explicit cancellations and never infers deletion from absence', async () => {
    // A confirmed event and a cancelled one; a previously-stored uid ("OLD")
    // is absent from this delta but must NOT be deleted (delta ≠ full set).
    pull.mockResolvedValue({
      events: [ev('A'), ev('GONE', 'cancelled')],
      fullSet: false,
      nextCursor: { token: 't2' },
    });

    const res = await syncCalendarAccount(account());

    expect(res.upserted).toBe(1);
    expect(deleteExternalEvents).toHaveBeenCalledWith('owner-1', 'cal-1', ['GONE']);
    // The absence-based path must not run for a delta provider.
    expect(listExternalEventUids).not.toHaveBeenCalled();
  });

  it('persists the provider cursor to sync_state', async () => {
    pull.mockResolvedValue({ events: [ev('A')], fullSet: false, nextCursor: { token: 't2' } });
    await syncCalendarAccount(account());
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ syncState: { token: 't2' } }));
  });

  it('falls back to the existing sync_state when the pull returns no cursor', async () => {
    pull.mockResolvedValue({ events: [], fullSet: false });
    await syncCalendarAccount(account({ syncState: { token: 'prev' } }));
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ syncState: { token: 'prev' } }),
    );
  });
});

describe('syncCalendarAccount — tagging + state bookkeeping', () => {
  it('slugs the calendar display name onto every upserted event as a tag', async () => {
    pull.mockResolvedValue({ events: [ev('A')], fullSet: true });
    await syncCalendarAccount(account({ displayName: 'My Work Calendar!!' }));
    expect(upsertExternalEvent).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({ tags: ['my-work-calendar'] }),
    );
  });

  it('records lastEventCount and clears lastSyncError on success', async () => {
    pull.mockResolvedValue({ events: [ev('A'), ev('B')], fullSet: true });
    await syncCalendarAccount(account());
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastEventCount: 2, lastSyncError: null }),
    );
  });
});
