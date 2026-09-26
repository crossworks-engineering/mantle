/**
 * Audit MED 12: a member (or team) message whose turn fails BEFORE the inbound
 * row is written used to vanish: the route had already answered 202 and
 * nothing reached the thread. Now the turn records the message with a failed
 * reply, then rethrows. Here the failure is the classic early one: the team
 * responder is missing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ appended: [] as Record<string, unknown>[] }));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
  chain['then'] = (resolve: (v: unknown[]) => void) => resolve([]); // no agent row
  return { ...actual, db: { select: () => chain } };
});
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appendTeamMessage: vi.fn(async (row: Record<string, unknown>) => {
    h.appended.push(row);
    return { id: `m${h.appended.length}` };
  }),
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runDurableStep: (_name: string, fn: () => Promise<unknown>) => fn(),
  emitTurnLifecycle: vi.fn(),
}));

import { runTeamTurn } from './run-team-turn';

beforeEach(() => {
  h.appended = [];
});

describe('runTeamTurn: an early failure leaves the message in the thread', () => {
  it('records the inbound and a failed outbound, then rethrows', async () => {
    await expect(
      runTeamTurn('owner-1', 'hello there', {
        contactId: 'contact-1',
        loginId: 'login-1',
        channel: 'web',
      }),
    ).rejects.toThrow(/isn't provisioned/);

    expect(h.appended).toHaveLength(2);
    expect(h.appended[0]).toMatchObject({
      direction: 'inbound',
      text: 'hello there',
      contactId: 'contact-1',
      loginId: 'login-1',
    });
    expect(h.appended[1]).toMatchObject({ direction: 'outbound', loginId: 'login-1' });
    expect(String(h.appended[1]!.error)).toMatch(/isn't provisioned/);
  });
});
