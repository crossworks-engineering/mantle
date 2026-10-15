/**
 * recentAgentContext hands each agent's own host (agents.base_url) to the
 * context-window lookup, so a key meant for a custom gateway is never used
 * on the provider's public host (fix round 2 L1). The database and the
 * lookup are stubs.
 */
import { describe, expect, it, vi } from 'vitest';

const { execute, agentContextWindow } = vi.hoisted(() => ({
  execute: vi.fn(),
  agentContextWindow: vi.fn(async () => ({ limit: 1000, source: 'static' })),
}));
vi.mock('@mantle/db', () => ({ db: { execute }, agents: {}, traceSteps: {}, traces: {} }));
vi.mock('@mantle/tracing', () => ({ refreshModelCatalog: vi.fn(async () => {}) }));
vi.mock('./model-explorer', () => ({ agentContextWindow }));

import { recentAgentContext } from './metrics';

describe('recentAgentContext', () => {
  it("selects the agent's base_url and passes it to the window lookup", async () => {
    execute.mockResolvedValueOnce([
      {
        agent_id: 'a1',
        agent_name: 'A',
        agent_slug: 'a',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        api_key_id: 'k1',
        base_url: 'https://gateway.example.test/v1',
        started_at: new Date().toISOString(),
        max_tokens_in: 500,
      },
    ]);
    const out = await recentAgentContext('owner');
    const query = execute.mock.calls[0]![0] as { queryChunks: unknown[] };
    expect(JSON.stringify(query.queryChunks)).toContain('a.base_url');
    expect(agentContextWindow).toHaveBeenCalledWith('owner', {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKeyId: 'k1',
      baseUrl: 'https://gateway.example.test/v1',
    });
    expect(out[0]!.pct).toBe(0.5);
  });
});
