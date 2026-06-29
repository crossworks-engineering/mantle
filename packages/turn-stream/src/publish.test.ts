/**
 * `publishTurnEvent` persists each event to the replay buffer (for `Last-Event-ID`
 * resume) AND fires the live `pg_notify`. The buffer write is gated on
 * `MANTLE_TURN_STREAMING`, which is now **on by default** — the buffer fills
 * unless the flag is explicitly disabled (0/false/off/no), mirroring the SSE
 * route. We mock `@mantle/db` (like tracing/store.test.ts) to capture writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnEvent } from '@mantle/client-types';

const h = vi.hoisted(() => ({
  buffer: { __t: 'turnStreamBuffer', createdAt: { __c: 'created_at' } },
  inserts: [] as Array<Record<string, unknown>>,
  deletes: 0,
  notifies: 0,
}));

vi.mock('@mantle/db', () => ({
  turnStreamBuffer: h.buffer,
  db: {
    insert: (_tbl: unknown) => ({
      values: (v: Record<string, unknown>) => {
        h.inserts.push(v);
        return { onConflictDoNothing: async () => {} };
      },
    }),
    delete: (_tbl: unknown) => ({
      where: async () => {
        h.deletes += 1;
      },
    }),
    execute: async () => {
      h.notifies += 1;
    },
  },
}));

import { publishTurnEvent } from './publish';

function ev(type: string, seq = 0): TurnEvent {
  return { v: 1, turnId: 't1', seq, round: 0, type, data: {} } as unknown as TurnEvent;
}

const FLAG = 'MANTLE_TURN_STREAMING';
let prev: string | undefined;

beforeEach(() => {
  prev = process.env[FLAG];
  h.inserts.length = 0;
  h.deletes = 0;
  h.notifies = 0;
});
afterEach(() => {
  if (prev === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prev;
});

describe('publishTurnEvent — replay buffer', () => {
  it('writes the event to the buffer when streaming is enabled', async () => {
    process.env[FLAG] = '1';
    await publishTurnEvent('owner-1', ev('text-delta', 5));
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({ turnId: 't1', seq: 5, ownerId: 'owner-1' });
    expect((h.inserts[0]!.event as TurnEvent).type).toBe('text-delta');
  });

  it('still fires the live pg_notify alongside the buffer write', async () => {
    process.env[FLAG] = '1';
    await publishTurnEvent('owner-1', ev('status', 2));
    expect(h.notifies).toBe(1);
  });

  it('writes to the buffer when the flag is unset (on by default)', async () => {
    delete process.env[FLAG];
    await publishTurnEvent('owner-1', ev('text-delta', 1));
    expect(h.inserts).toHaveLength(1);
    expect(h.notifies).toBe(1);
  });

  it('does NOT write when the flag is explicitly disabled (0)', async () => {
    process.env[FLAG] = '0';
    await publishTurnEvent('owner-1', ev('text-delta', 1));
    expect(h.inserts).toHaveLength(0);
    // The notify stays unconditional (pre-existing behaviour; harmless when dark).
    expect(h.notifies).toBe(1);
  });

  it('sweeps expired rows on a turn-start event (once per turn), not on a delta', async () => {
    process.env[FLAG] = '1';
    await publishTurnEvent('owner-1', ev('text-delta', 1));
    expect(h.deletes).toBe(0);
    await publishTurnEvent('owner-1', ev('turn-start', 0));
    expect(h.deletes).toBe(1);
  });
});
