/**
 * search_chunks spends nothing on the brain owner's keys for a login outside
 * an Admin scope (workspaces W7b fix round 2, M-a): with the passage_scoring
 * decision use on, a direct MCP, key or peer call of such a login makes no
 * decider request and gets the plain ranking; an Admin's call, and a call
 * with no MCP channel (a workspace assistant's turn), still score.
 *
 * The retriever, the embedder and the decider are stubbed; no database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/embeddings', () => ({
  embed: vi.fn(async () => [0.1, 0.2]),
  chunkWindowsEnabled: vi.fn(async () => false),
}));
vi.mock('@mantle/search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/search')>()),
  searchChunksExplained: vi.fn(),
  resolveSupersededTargets: vi.fn(async () => new Map()),
}));
vi.mock('@mantle/decisions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/decisions')>()),
  decisionUseEnabled: vi.fn(),
  scorePassages: vi.fn(),
}));

import { searchChunksExplained } from '@mantle/search';
import { decisionUseEnabled, scorePassages } from '@mantle/decisions';
import { search_chunks } from './builtins-search';
import { ownerKeysOff } from './surface';
import type { ToolHandlerContext } from './types';

const HITS = Array.from({ length: 6 }, (_, i) => ({
  nodeId: `00000000-0000-4000-8000-00000000000${i}`,
  nodeTitle: `Doc ${i}`,
  nodeType: 'file',
  headingPath: `H${i}`,
  ordinal: i,
  text: `passage ${i}`,
  distance: 0.1 * i,
}));

beforeEach(() => {
  vi.mocked(searchChunksExplained).mockReset();
  vi.mocked(searchChunksExplained).mockResolvedValue({ hits: HITS, search: {} } as never);
  vi.mocked(decisionUseEnabled).mockReset();
  vi.mocked(decisionUseEnabled).mockResolvedValue({ enabled: true, mode: 'live' } as never);
  vi.mocked(scorePassages).mockReset();
  // The decider keeps the last passage only, ranked first.
  vi.mocked(scorePassages).mockResolvedValue({
    mode: 'live',
    threshold: 1,
    ms: 1,
    cached: false,
    scores: new Map(
      HITS.map((h, i) => [`${h.nodeId}:${h.ordinal}`, { score: i === 5 ? 3 : 0, confidence: 1 }]),
    ),
  } as never);
});

function ctx(surface: ToolHandlerContext['surface']): ToolHandlerContext {
  return { ownerId: 'owner-1', surface } as ToolHandlerContext;
}

const MEMBER_MCP: ToolHandlerContext['surface'] = {
  kind: 'owner',
  via: 'mcp',
  loginId: 'member-1',
  mcp: { via: 'oauth', write: true, ownerKeysOff: true },
};

describe('search_chunks on a connection outside an Admin scope (M-a)', () => {
  it('a member makes zero decider calls and gets the plain ranking', async () => {
    for (const surface of [
      MEMBER_MCP,
      {
        ...MEMBER_MCP,
        via: 'api' as const,
        mcp: { via: 'key' as const, write: false, ownerKeysOff: true },
      },
      {
        ...MEMBER_MCP,
        via: 'federation' as const,
        mcp: { via: 'peer' as const, write: true, ownerKeysOff: true },
      },
    ]) {
      expect(ownerKeysOff({ surface })).toBe(true);
      const r = await search_chunks.handler({ q: 'inventory grouping', limit: 3 }, ctx(surface));
      expect(r.ok).toBe(true);
      const out = (r as { output: Array<{ nodeId: string; relevance?: number }> }).output;
      expect(out.map((h) => h.nodeId)).toEqual(HITS.slice(0, 3).map((h) => h.nodeId));
      expect(out.some((h) => h.relevance !== undefined)).toBe(false);
    }
    expect(scorePassages).not.toHaveBeenCalled();
    // Not even the switch is read: the pool is the plain one.
    expect(decisionUseEnabled).not.toHaveBeenCalled();
    for (const call of vi.mocked(searchChunksExplained).mock.calls) {
      expect((call[0] as { limit: number }).limit).toBe(3);
    }
  });

  it('an Admin connection still scores', async () => {
    const admin = {
      ...MEMBER_MCP,
      loginId: 'admin-1',
      mcp: { via: 'oauth' as const, write: true },
    };
    expect(ownerKeysOff({ surface: admin })).toBe(false);
    const r = await search_chunks.handler({ q: 'inventory grouping', limit: 3 }, ctx(admin));
    expect(r.ok).toBe(true);
    expect(scorePassages).toHaveBeenCalledTimes(1);
    const out = (r as { output: Array<{ nodeId: string; relevance?: number }> }).output;
    expect(out[0]?.nodeId).toBe(HITS[5]!.nodeId);
    expect(out[0]?.relevance).toBe(3);
  });

  it('a turn with no MCP channel (a workspace assistant) keeps its rules', async () => {
    const turn: ToolHandlerContext['surface'] = { kind: 'web', loginId: 'member-1' } as never;
    expect(ownerKeysOff({ surface: turn })).toBe(false);
    await search_chunks.handler({ q: 'inventory grouping', limit: 3 }, ctx(turn));
    expect(scorePassages).toHaveBeenCalledTimes(1);
  });
});
