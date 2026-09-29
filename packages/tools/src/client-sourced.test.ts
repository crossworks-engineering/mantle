/**
 * The client-sourced taint helpers (client logins C4, plan N18) without a
 * database: which calls count as a lowering, how ids are found, and that a
 * failed check marks the turn (fail closed). The real query:
 * client-sourced.db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ hit: false, throws: false, queries: 0 }));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      h.queries++;
      if (h.throws) throw new Error('db down');
      return h.hit ? [{ id: 'x' }] : [];
    },
  };
  return { ...actual, db: { select: () => chain } };
});

import { isLoweringCall, newTurnTaint, taintFromText, uuidsIn } from './client-sourced';

const ID = '99999999-9999-4999-8999-999999999999';

describe('isLoweringCall', () => {
  it('access_set to client or public; not to team or admin', () => {
    expect(isLoweringCall('access_set', { level: 'public' })).toBe(true);
    expect(isLoweringCall('access_set', { level: 'client' })).toBe(true);
    expect(isLoweringCall('access_set', { level: 'team' })).toBe(false);
    expect(isLoweringCall('access_set', { level: 'admin' })).toBe(false);
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
  it('checks at most 500', () => {
    const many = Array.from(
      { length: 600 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    ).join(' ');
    expect(uuidsIn(many)).toHaveLength(500);
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
