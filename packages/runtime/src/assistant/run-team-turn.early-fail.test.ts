/**
 * Audit MED 12: a member (or team) message whose turn fails BEFORE the inbound
 * row is written used to vanish: the route had already answered 202 and
 * nothing reached the thread. Now the turn records the message with a failed
 * reply in the login's own thread with the assistant, then rethrows. Since
 * W7c (0269) a row belongs to one agent's thread: a turn whose assistant was
 * never resolved (the Team workspace has none) has no thread to land in, so
 * only the error remains; once the assistant is known (here: it has no key),
 * the message and the failed reply are recorded in that thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  appended: [] as Record<string, unknown>[],
  team: null as null | { id: string; slug: string; name: string; workspaceId: string },
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'limit']) chain[m] = () => chain;
  // The agent row: the Team workspace's assistant, with no key set.
  chain['then'] = (resolve: (v: unknown[]) => void) =>
    resolve(
      h.team
        ? [{ id: h.team.id, slug: h.team.slug, workspaceId: h.team.workspaceId, apiKeyId: null }]
        : [],
    );
  return { ...actual, db: { select: () => chain } };
});
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  defaultWorkspaceAssistant: vi.fn(async () => h.team),
  appendThreadMessage: vi.fn(async (row: Record<string, unknown>) => {
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
  h.team = null;
});

describe('runTeamTurn: an early failure', () => {
  it('with no assistant to answer: rethrows, and no thread gets a row', async () => {
    await expect(
      runTeamTurn('owner-1', 'hello there', { loginId: 'login-1', channel: 'web' }),
    ).rejects.toThrow(/no workspace other than Admin with an enabled assistant/);
    expect(h.appended).toEqual([]);
  });

  it('once the assistant is known: the inbound and a failed outbound in its thread', async () => {
    h.team = { id: 'agent-1', slug: 'team-responder', name: 'Team', workspaceId: 'ws-team' };
    await expect(
      runTeamTurn('owner-1', 'hello there', { loginId: 'login-1', channel: 'web' }),
    ).rejects.toThrow(/no api_key_id/);
    expect(h.appended).toHaveLength(2);
    expect(h.appended[0]).toMatchObject({
      direction: 'inbound',
      text: 'hello there',
      agentId: 'agent-1',
      loginId: 'login-1',
    });
    expect(h.appended[1]).toMatchObject({
      direction: 'outbound',
      agentId: 'agent-1',
      loginId: 'login-1',
    });
    expect(String(h.appended[1]!.error)).toMatch(/no api_key_id/);
  });
});

describe('runTeamTurn: the retired portal contact path', () => {
  // A turn input from before Phase 6 names only a portal contact. It must be
  // refused before anything is written, not run into an unowned thread.
  it('refuses a turn with no member login', async () => {
    await expect(
      runTeamTurn('owner-1', 'hello there', { contactId: 'contact-1' } as never),
    ).rejects.toThrow(/loginId required/);
    expect(h.appended).toEqual([]);
  });
});
