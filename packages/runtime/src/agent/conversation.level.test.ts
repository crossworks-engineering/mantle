/**
 * The turn's retrieval runs at the agent's level (member logins Phase 0b):
 * loadConversationContext for a team-level agent reads the brain on the team
 * viewer role. The audit removed this wrap and every test stayed green; this
 * pins it. No database: every read of `db` and the query embedding record
 * `currentViewerLevel()` at the moment they run (and the reads then fail,
 * which the loader may soften; only the levels matter here).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentViewerLevel } from '@mantle/db/viewer';
import type { Agent } from '@mantle/db';

const h = vi.hoisted(() => ({ levels: [] as string[] }));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const record = (what: string) => {
    h.levels.push(`${what}:${currentViewerLevel()}`);
    throw new Error('no database in this test');
  };
  return {
    ...actual,
    db: new Proxy({}, { get: () => record('db') }),
    systemDb: new Proxy({}, { get: () => record('systemDb') }),
  };
});

vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => {
    h.levels.push(`embed:${currentViewerLevel()}`);
    return new Array(768).fill(0.01);
  }),
}));

import { loadConversationContext } from './conversation';

const agent = (audience: string) =>
  ({
    id: 'agent-1',
    ownerId: 'owner-1',
    slug: 'team-responder',
    audience,
    memoryConfig: { digest_limit: 0 },
    personaNotes: [],
  }) as unknown as Agent;

const load = (audience: string) =>
  loadConversationContext({
    ownerId: 'owner-1',
    agent: agent(audience),
    inboundText: 'what does the handbook say about leave?',
    includeJournal: false,
  }).catch(() => null);

beforeEach(() => {
  h.levels = [];
});

describe('loadConversationContext runs at the agent level', () => {
  it('a team agent: every brain read runs at team', async () => {
    await load('team');
    expect(h.levels.length, 'the loader read the brain').toBeGreaterThan(0);
    expect(h.levels.filter((l) => !l.endsWith(':team'))).toEqual([]);
    expect(currentViewerLevel()).toBe('admin'); // the scope ends with the call
  });

  it('control: an admin agent reads at admin', async () => {
    await load('admin');
    expect(h.levels.length).toBeGreaterThan(0);
    expect(h.levels.filter((l) => !l.endsWith(':admin'))).toEqual([]);
  });
});
