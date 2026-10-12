/**
 * The turn's retrieval runs in the agent's scope (member logins Phase 0b,
 * workspaces W5b2, W8c): loadConversationContext for the assistant of a
 * workspace other than Admin reads the brain in a turn scope of that
 * workspace, never as system work. The audit removed this wrap and every
 * test stayed green; this pins it. No database: the agent's workspace
 * lookups answer a live, non-Admin workspace, withTurnScope enters the scope
 * alone, and every other read of `db` and the query embedding record the
 * scope they run in (the reads then fail, which the loader may soften; only
 * the scopes matter here).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentScope } from '@mantle/db/viewer';
import type { Agent } from '@mantle/db';

const h = vi.hoisted(() => ({ levels: [] as string[], embedded: [] as string[] }));

/** The scope the code runs in: 'admin' for system work, else the workspace
 *  scope's kind and workspaces. */
function where(): string {
  const s = currentScope();
  if (s.kind === 'system') return 'admin';
  return `${s.kind}(${s.ws.join(',')})`;
}

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { runInViewerScope } = await import('@mantle/db/viewer');
  const record = (what: string) => {
    h.levels.push(`${what}:${where()}`);
    throw new Error('no database in this test');
  };
  // The agent's workspace lookups (agent-viewer.ts, on the system pool): a
  // live workspace that is not Admin. Any other table is a brain read.
  const lookup = (table: unknown) => {
    const rows =
      table === actual.workspaces
        ? [{ isAdmin: false, ownerId: 'owner-1', archivedAt: null }]
        : table === actual.workspaceUsers
          ? [{ moderator: false }]
          : null;
    if (!rows) return record('db');
    const chain: Record<string, unknown> = { where: () => chain, limit: async () => rows };
    return chain;
  };
  return {
    ...actual,
    db: new Proxy(
      {},
      {
        get: (_t, prop) => (prop === 'select' ? () => ({ from: lookup }) : record('db')),
      },
    ),
    systemDb: new Proxy({}, { get: () => record('systemDb') }),
    // A turn scope without a database: the scope alone.
    withTurnScope: vi.fn((scope: never, fn: () => Promise<unknown>) => runInViewerScope(scope, fn)),
  };
});

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async (_owner: string, text: string) => {
    h.levels.push(`embed:${where()}`);
    h.embedded.push(text);
    return new Array(768).fill(0.01);
  }),
}));

import { loadConversationContext } from './conversation';

/** The Team workspace's assistant, or (null) a helper on no workspace. */
const agent = (workspaceId: string | null) =>
  ({
    id: 'agent-1',
    ownerId: 'owner-1',
    slug: 'team-responder',
    workspaceId,
    memoryConfig: { digest_limit: 0 },
    personaNotes: [],
  }) as unknown as Agent;

const load = (workspaceId: string | null) =>
  loadConversationContext({
    ownerId: 'owner-1',
    agent: agent(workspaceId),
    inboundText: 'what does the handbook say about leave?',
    includeJournal: false,
  }).catch(() => null);

beforeEach(() => {
  h.levels = [];
  h.embedded = [];
});

describe('loadConversationContext runs in the agent scope', () => {
  it('the Team workspace’s assistant: every brain read runs in its workspace scope', async () => {
    await load('ws-team');
    expect(h.levels.length, 'the loader read the brain').toBeGreaterThan(0);
    expect(h.levels.filter((l) => !l.endsWith(':assistant(ws-team)'))).toEqual([]);
    expect(where()).toBe('admin'); // the scope ends with the call
  });

  it('control: a helper answering no login is system work', async () => {
    await load(null);
    expect(h.levels.length).toBeGreaterThan(0);
    expect(h.levels.filter((l) => !l.endsWith(':admin'))).toEqual([]);
  });
});

// NATREF 2026-09-29: every short follow-up on the member chat ("what about in
// pages?") failed, as the query enrichment read the owner's assistant_messages
// at team, where the role had no grant. Here any db read throws, so a loader
// that still reads it never reaches the embedding.
describe('a short follow-up in a workspace turn', () => {
  const followup = (recentTurnTexts?: string[]) =>
    loadConversationContext({
      ownerId: 'owner-1',
      agent: agent('ws-team'),
      inboundText: 'What about in pages?',
      includeJournal: false,
      recentTurnTexts,
    }).catch(() => null);

  it('is enriched from the turn texts the surface passes, not the owner chat', async () => {
    await followup(['Can you see the code in the test doc?', 'Nothing by that name.']);
    expect(h.embedded[0]).toBe(
      'Can you see the code in the test doc? Nothing by that name.\nWhat about in pages?',
    );
  });

  it('with no texts passed, embeds the message alone', async () => {
    await followup();
    expect(h.embedded[0]).toBe('What about in pages?');
  });
});
