/**
 * The conversation store's writes (conversation-writes.ts), their SQL shape
 * and the login a row names. systemDb is mocked with a chain that captures
 * each statement's SET and WHERE, compiled with PgDialect; the spot is
 * recorded. The rows on a real database: conversation-writes.db.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  updates: [] as Array<{ payload: Record<string, unknown>; where: unknown }>,
  inserts: [] as Array<Record<string, unknown>>,
  spots: [] as string[],
}));

vi.mock('./gateway/handles', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  systemDb: {
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: (where: unknown) => {
          h.updates.push({ payload, where });
          return { returning: () => Promise.resolve([{ id: 'in-1' }, { id: 'out-1' }]) };
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push(values);
        return { returning: () => Promise.resolve([{ id: 'row-1', ...values }]) };
      },
    }),
  },
}));
vi.mock('./viewer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  onFullSystemRoute: async (spot: string, fn: () => Promise<unknown>) => {
    h.spots.push(spot);
    return fn();
  },
}));

import { loginActor, runAsActor, runAsSystem } from './actor';
import {
  insertConversationRow,
  settleConversationRow,
  supersedeConversationTurn,
  threadLoginFor,
  ThreadLoginMismatchError,
} from './conversation-writes';

const dialect = new PgDialect();
const compile = (fragment: SQL) => dialect.sqlToQuery(fragment);
const MEMBER = '00000000-0000-4000-8000-0000000000d1';
const OTHER = '00000000-0000-4000-8000-0000000000d2';

beforeEach(() => {
  h.updates.length = 0;
  h.inserts.length = 0;
  h.spots.length = 0;
});

describe('threadLoginFor: the login a turn row names', () => {
  it("a login actor bound: that login, given or not; another login's thread refused", async () => {
    await runAsActor(loginActor(MEMBER), async () => {
      expect(threadLoginFor(undefined)).toBe(MEMBER);
      expect(threadLoginFor(null)).toBe(MEMBER);
      expect(threadLoginFor(MEMBER.toUpperCase())).toBe(MEMBER);
      expect(() => threadLoginFor(OTHER)).toThrow(ThreadLoginMismatchError);
    });
  });

  it('any other actor: the login as given, or none (the stamp gives the anchor)', async () => {
    await runAsSystem('worker:conversation-test', async () => {
      expect(threadLoginFor(OTHER)).toBe(OTHER);
      expect(threadLoginFor(undefined)).toBeNull();
    });
    await runAsActor({ kind: 'assistant', agentId: null }, async () => {
      expect(threadLoginFor(OTHER)).toBe(OTHER);
    });
  });
});

describe('insertConversationRow', () => {
  it("a member's turn row names the member, not the anchor, though the caller named none", async () => {
    await runAsActor(loginActor(MEMBER), () =>
      insertConversationRow({ ownerId: 'o', agentId: 'a', direction: 'inbound', text: 'hi' }),
    );
    expect(h.inserts[0]).toMatchObject({ loginId: MEMBER });
  });

  it("a row naming another login's thread is refused before anything is written", async () => {
    await expect(
      runAsActor(loginActor(MEMBER), () =>
        insertConversationRow({
          ownerId: 'o',
          agentId: 'a',
          direction: 'inbound',
          text: 'hi',
          loginId: OTHER,
        }),
      ),
    ).rejects.toThrow(ThreadLoginMismatchError);
    expect(h.inserts).toEqual([]);
  });

  it('system work with no login names none (the stamp: the anchor), as before', async () => {
    await runAsSystem('worker:conversation-test', () =>
      insertConversationRow({ ownerId: 'o', agentId: 'a', direction: 'outbound', text: 'x' }),
    );
    expect(h.inserts[0]).not.toHaveProperty('loginId');
  });
});

describe('settleConversationRow', () => {
  it('writes each column it is given, leaves an undefined one, merges data; owner-scoped', async () => {
    await settleConversationRow('owner-1', 'out-1', {
      status: 'complete',
      text: 'done',
      dataPatch: { toolStats: { calls: 1 } },
    });
    const { payload, where } = h.updates[0]!;
    expect(payload).toMatchObject({ status: 'complete', text: 'done' });
    // undefined: drizzle leaves the column as it is (mapUpdateSet).
    expect(payload.attachments).toBeUndefined();
    expect(payload.error).toBeUndefined();
    const data = compile(payload.data as SQL);
    expect(data.sql).toContain(`"assistant_messages"."data" || `);
    const cond = compile(where as SQL);
    expect(cond.params).toEqual(['out-1', 'owner-1']);
  });

  it('no data patch: data is not written', async () => {
    await settleConversationRow('owner-1', 'out-1', { status: 'failed', error: 'x' });
    expect(h.updates[0]!.payload).not.toHaveProperty('data');
  });
});

describe('supersedeConversationTurn', () => {
  it('stamps BOTH pair rows of the login thread, owner-scoped, by a data merge, at its spot', async () => {
    const n = await runAsActor(loginActor(MEMBER), () =>
      supersedeConversationTurn({
        ownerId: 'owner-1',
        inboundId: 'in-1',
        outboundId: 'out-1',
        newTurnId: 'turn-2',
        loginId: MEMBER,
      }),
    );
    expect(n).toBe(2);
    expect(h.spots).toEqual(['turn-supersede']);
    const { payload, where } = h.updates[0]!;
    // The stamp merges onto the existing jsonb (`data || patch`) so it can't
    // clobber thoughts/toolStats, and survives the finalize merge in turn.
    const set = compile(payload.data as SQL);
    expect(set.sql).toContain(`"assistant_messages"."data" || `);
    expect(set.params).toEqual([JSON.stringify({ superseded_by: 'turn-2' })]);
    // Ids guessed from another owner or another login's thread match nothing.
    const cond = compile(where as SQL);
    expect(cond.sql).toContain(`"assistant_messages"."id" in (`);
    expect(cond.sql).toContain(`"assistant_messages"."owner_id" = `);
    expect(cond.sql).toContain(`"assistant_messages"."login_id" = `);
    expect(cond.params).toEqual(['in-1', 'out-1', 'owner-1', MEMBER]);
  });

  it("another login's pair is refused before anything is written", async () => {
    await expect(
      runAsActor(loginActor(MEMBER), () =>
        supersedeConversationTurn({
          ownerId: 'owner-1',
          inboundId: 'in-1',
          outboundId: 'out-1',
          newTurnId: 'turn-2',
          loginId: OTHER,
        }),
      ),
    ).rejects.toThrow(ThreadLoginMismatchError);
    expect(h.updates).toEqual([]);
  });
});
