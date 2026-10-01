/**
 * The client-sourced taint helpers (client logins C4, plan N18) without a
 * database: which calls count as a lowering, how ids are found, and that a
 * failed check marks the turn (fail closed). The real query:
 * client-sourced.db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hit: false,
  throws: false,
  queries: 0,
  /** Answer yes on this query only (1-based), to see which batch was asked. */
  hitOnQuery: 0,
  kept: [] as Record<string, unknown>[],
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: async () => {
      h.queries++;
      if (h.throws) throw new Error('db down');
      return h.hit || h.queries === h.hitOnQuery ? [{ id: 'x' }] : [];
    },
  };
  const insert = () => ({
    values: (row: Record<string, unknown>) => ({
      onConflictDoUpdate: async () => {
        h.kept.push(row);
      },
    }),
  });
  return { ...actual, db: { select: () => chain, insert } };
});

import {
  conversationTaintKey,
  ID_BATCH,
  isLoweringCall,
  namesClientSourced,
  newTurnTaint,
  taintFromText,
  uuidsIn,
  type TurnTaint,
} from './client-sourced';

const ID = '99999999-9999-4999-8999-999999999999';

describe('isLoweringCall', () => {
  it('access_set to client or public; not to team or admin', () => {
    expect(isLoweringCall('access_set', { level: 'public' })).toBe(true);
    expect(isLoweringCall('access_set', { level: 'client' })).toBe(true);
    expect(isLoweringCall('access_set', { level: 'team' })).toBe(false);
    expect(isLoweringCall('access_set', { level: 'admin' })).toBe(false);
  });
  it('reads the level as access_set does, trimmed, and lower-cased on top (L9)', () => {
    expect(isLoweringCall('access_set', { level: ' client ' })).toBe(true);
    expect(isLoweringCall('access_set', { level: 'PUBLIC' })).toBe(true);
    expect(isLoweringCall('access_set', { level: '\tPublic\n' })).toBe(true);
    expect(isLoweringCall('access_set', { level: ' team ' })).toBe(false);
    expect(isLoweringCall('access_set', { level: 3 })).toBe(false);
  });
  it('every share link; email_page only with a link', () => {
    expect(isLoweringCall('node_share', {})).toBe(true);
    expect(isLoweringCall('page_share', { id: 'p' })).toBe(true);
    expect(isLoweringCall('email_page', { includeLink: true })).toBe(true);
    expect(isLoweringCall('email_page', { includeLink: 'true' })).toBe(true);
    expect(isLoweringCall('email_page', {})).toBe(false);
  });
  it('anything else is not', () => {
    expect(isLoweringCall('page_update', { level: 'public' })).toBe(false);
    expect(isLoweringCall('access_get', { level: 'public' })).toBe(false);
  });
});

describe('uuidsIn', () => {
  it('finds distinct ids, lower-cased, inside any text', () => {
    expect(uuidsIn(`{"id":"${ID.toUpperCase()}","x":"${ID}"} tail`)).toEqual([ID]);
    expect(uuidsIn('no ids here')).toEqual([]);
  });
  it('finds every id, however many (no cut-off, L8)', () => {
    const many = Array.from(
      { length: 2600 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    ).join(' ');
    expect(uuidsIn(many)).toHaveLength(2600);
  });
});

describe('namesClientSourced checks every id, in batches (L8)', () => {
  const ids = Array.from(
    { length: ID_BATCH * 2 + 5 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
  it('asks every batch: five questions each, three batches', async () => {
    h.hit = false;
    h.throws = false;
    h.queries = 0;
    h.hitOnQuery = 0;
    expect(await namesClientSourced('o', ids)).toBe(false);
    expect(h.queries).toBe(15);
  });
  it('a client request in the LAST batch is found', async () => {
    h.queries = 0;
    // Query 11 is the first question of the third batch (ids past 2000).
    h.hitOnQuery = 11;
    expect(await namesClientSourced('o', ids)).toBe(true);
    h.hitOnQuery = 0;
  });
});

describe('the conversation mark (I9)', () => {
  it("keys the owner's conversation with an agent, and a login's own", () => {
    expect(conversationTaintKey('a1', { kind: 'web' })).toBe('agent:a1');
    expect(conversationTaintKey('a1', { kind: 'telegram' })).toBe('agent:a1');
    expect(conversationTaintKey('a1', null)).toBe('agent:a1');
    expect(conversationTaintKey('a1', { kind: 'team', loginId: 'm1' })).toBe('login:m1:agent:a1');
    expect(conversationTaintKey('a1', { kind: 'client', loginId: 'c1' })).toBe('login:c1:agent:a1');
  });
  it('a read keeps the mark on the conversation; a carried mark is renewed by a new read', async () => {
    h.hit = true;
    h.throws = false;
    h.kept = [];
    const conversation = { ownerId: 'o', key: 'agent:a1' };
    const fresh: TurnTaint = { clientSourced: false, conversation };
    await taintFromText(fresh, 'o', `{"id":"${ID}"}`, 'task_get');
    expect(fresh).toEqual({ clientSourced: true, via: 'task_get', conversation });
    expect(h.kept).toEqual([{ ownerId: 'o', conversationKey: 'agent:a1', via: 'task_get' }]);
    // Marked in this turn already: no second write, no second look.
    const before = h.queries;
    await taintFromText(fresh, 'o', `{"id":"${ID}"}`, 'task_list');
    expect(h.kept).toHaveLength(1);
    expect(h.queries).toBe(before);
    // Carried from an earlier turn: a new read is still looked for, and renews.
    const carried: TurnTaint = {
      clientSourced: true,
      via: 'an earlier turn',
      carried: true,
      conversation,
    };
    await taintFromText(carried, 'o', `{"id":"${ID}"}`, 'page_get');
    expect(carried).toEqual({ clientSourced: true, via: 'page_get', conversation });
    expect(h.kept).toHaveLength(2);
    h.hit = false;
  });
  it('a turn with no conversation keeps nothing', async () => {
    h.hit = true;
    h.kept = [];
    const t = newTurnTaint();
    await taintFromText(t, 'o', `{"id":"${ID}"}`, 'task_get');
    expect(t.clientSourced).toBe(true);
    expect(h.kept).toEqual([]);
    h.hit = false;
  });
});

describe('taintFromText', () => {
  it('marks the turn when an id names client-sourced text, with what did it', async () => {
    h.hit = true;
    h.throws = false;
    const t = newTurnTaint();
    await taintFromText(t, 'o', `{"id":"${ID}"}`, 'task_get');
    expect(t).toEqual({ clientSourced: true, via: 'task_get' });
  });
  it('leaves it clean when no id does, and asks nothing for text with no ids', async () => {
    h.hit = false;
    h.throws = false;
    const t = newTurnTaint();
    await taintFromText(t, 'o', `{"id":"${ID}"}`, 'task_get');
    expect(t.clientSourced).toBe(false);
    const before = h.queries;
    await taintFromText(t, 'o', 'plain text', 'x');
    expect(h.queries).toBe(before);
  });
  it('a failed check marks the turn (fail closed)', async () => {
    h.throws = true;
    const t = newTurnTaint();
    await taintFromText(t, 'o', `{"id":"${ID}"}`, 'task_get');
    expect(t.clientSourced).toBe(true);
    h.throws = false;
  });
});
