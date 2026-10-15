/**
 * The agent form and the dashboard say the same context window (one helper,
 * contextWindowFor): the provider's own figure where the brain has the
 * provider's model list (Anthropic's max_input_tokens), else the OpenRouter
 * window for the model's OpenRouter id. The vault is a fake and the
 * providers a stubbed fetch: nothing reaches Anthropic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextLimitFor, contextSourceFor } from '@mantle/tracing';

const OWNER = '33333333-3333-4333-8333-333333333333';
const KEY = '11111111-1111-4111-8111-111111111111';

vi.mock('@mantle/api-keys', () => ({
  findProviderKeyId: vi.fn(async () => KEY),
  getApiKeyById: vi.fn(async () => ({ apiKey: 'test-not-a-key' })),
}));

import {
  agentContextWindow,
  clearModelCache,
  contextWindowFor,
  fetchProviderModels,
} from './model-explorer';

const OWN = 123_456;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      // The OpenRouter catalog is down: the mapping reads the static table.
      if (String(url).includes('openrouter.ai')) return new Response('down', { status: 503 });
      return Response.json({
        data: [
          // A model the Models API gives its own window.
          { type: 'model', id: 'claude-opus-4-7', max_input_tokens: OWN },
          // One it gives none: the mapping fills it.
          { type: 'model', id: 'claude-sonnet-4-6' },
        ],
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearModelCache();
});

describe('contextWindowFor', () => {
  it("prefers the provider's own figure, else the OpenRouter mapping", () => {
    const mapped = contextLimitFor('anthropic/claude-opus-4.7');
    expect(mapped).toBeGreaterThan(0);
    expect(contextWindowFor('anthropic', 'claude-opus-4-7', OWN)).toEqual({
      limit: OWN,
      source: 'live',
    });
    expect(contextWindowFor('anthropic', 'claude-opus-4-7')).toEqual({
      limit: mapped,
      source: contextSourceFor('anthropic/claude-opus-4.7'),
    });
    expect(contextWindowFor('anthropic', 'no-such-model-x')).toEqual({
      limit: null,
      source: 'unknown',
    });
    expect(contextWindowFor('openrouter', 'anthropic/claude-opus-4.7').limit).toBe(mapped);
  });
});

describe('the form and the dashboard agree', () => {
  const agent = (model: string) => ({ provider: 'anthropic', model, apiKeyId: KEY });

  it('reads the mapping until the list is cached, then the same number as the form', async () => {
    const before = await agentContextWindow(OWNER, agent('claude-opus-4-7'));
    expect(before.limit).toBe(contextLimitFor('anthropic/claude-opus-4.7'));

    // The list the agent form reads (GET /api/models), same cache.
    const list = await fetchProviderModels(OWNER, 'anthropic', { keyId: KEY });
    const form = (id: string) => list.models.find((m) => m.id === id)?.contextTokens;
    expect(form('claude-opus-4-7')).toBe(OWN);

    const own = await agentContextWindow(OWNER, agent('claude-opus-4-7'));
    expect(own).toEqual({ limit: OWN, source: 'live' });
    const mapped = await agentContextWindow(OWNER, agent('claude-sonnet-4-6'));
    expect(mapped.limit).toBe(form('claude-sonnet-4-6'));
    expect(mapped.limit).toBe(contextLimitFor('anthropic/claude-sonnet-4.6'));
    expect(mapped.limit).toBeGreaterThan(0);
  });

  it('an OpenRouter agent and an unknown provider read the mapping, with no fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const or = await agentContextWindow(OWNER, {
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4.7',
      apiKeyId: null,
    });
    expect(or.limit).toBe(contextLimitFor('anthropic/claude-opus-4.7'));
    expect(
      (await agentContextWindow(OWNER, { provider: 'nope', model: 'x', apiKeyId: null })).limit,
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
