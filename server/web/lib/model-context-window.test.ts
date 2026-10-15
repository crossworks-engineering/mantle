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

describe("the dashboard's background fetch is bounded (fix round 2 M1)", () => {
  const agent = (model: string) => ({ provider: 'anthropic', model, apiKeyId: KEY });
  const anthropicCalls = (spy: ReturnType<typeof vi.fn>) =>
    spy.mock.calls.filter(([url]) => !String(url).includes('openrouter.ai')).length;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('concurrent callers on one key share one fetch', async () => {
    const spy = vi.fn(async () =>
      Response.json({ data: [{ type: 'model', id: 'claude-opus-4-7' }] }),
    );
    vi.stubGlobal('fetch', spy);
    // Five agents on one key, cold cache, one dashboard render.
    await Promise.all(
      Array.from({ length: 5 }, () => agentContextWindow(OWNER, agent('claude-opus-4-7'))),
    );
    // The form's list asked at the same moment joins the same request.
    await Promise.all([
      fetchProviderModels(OWNER, 'anthropic', { keyId: KEY }),
      fetchProviderModels(OWNER, 'anthropic', { keyId: KEY }),
    ]);
    await settle();
    expect(anthropicCalls(spy)).toBe(1);
  });

  it('a failing key is not asked again within the backoff window, and logs once', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.fn(async () => new Response('{"error":"nope"}', { status: 401 }));
    vi.stubGlobal('fetch', spy);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Many polls (and agents) while the key fails.
      for (let i = 0; i < 6; i++) {
        await agentContextWindow(OWNER, agent('claude-opus-4-7'));
        await agentContextWindow(OWNER, agent('claude-sonnet-4-6'));
        await settle();
      }
      expect(anthropicCalls(spy)).toBe(1);
      expect(errors).toHaveBeenCalledTimes(1);

      // Still inside the window: nothing new.
      vi.setSystemTime(Date.now() + 4 * 60_000);
      await agentContextWindow(OWNER, agent('claude-opus-4-7'));
      await settle();
      expect(anthropicCalls(spy)).toBe(1);

      // Past it: one more try.
      vi.setSystemTime(Date.now() + 2 * 60_000);
      await agentContextWindow(OWNER, agent('claude-opus-4-7'));
      await settle();
      expect(anthropicCalls(spy)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the form is not held back by the backoff, and its success clears it', async () => {
    let fail = true;
    const spy = vi.fn(async () =>
      fail
        ? new Response('down', { status: 503 })
        : Response.json({
            data: [{ type: 'model', id: 'claude-opus-4-7', max_input_tokens: OWN }],
          }),
    );
    vi.stubGlobal('fetch', spy);
    await agentContextWindow(OWNER, agent('claude-opus-4-7'));
    await settle();
    expect(anthropicCalls(spy)).toBe(1);

    fail = false;
    const list = await fetchProviderModels(OWNER, 'anthropic', { keyId: KEY });
    expect(list.error).toBeUndefined();
    expect(anthropicCalls(spy)).toBe(2);
    expect(await agentContextWindow(OWNER, agent('claude-opus-4-7'))).toEqual({
      limit: OWN,
      source: 'live',
    });
  });
});

describe('the cache through TtlCache (A10 #15 fix round 1, M2)', () => {
  const agent = (model: string) => ({ provider: 'anthropic', model, apiKeyId: KEY });
  const anthropicCalls = (spy: ReturnType<typeof vi.fn>) =>
    spy.mock.calls.filter(([url]) => !String(url).includes('openrouter.ai')).length;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('a stale list answers the dashboard while one refresh runs; a failed refresh keeps it', async () => {
    let fail = false;
    const spy = vi.fn(async (url: unknown) =>
      String(url).includes('openrouter.ai') || fail
        ? new Response('down', { status: 503 })
        : Response.json({
            data: [{ type: 'model', id: 'claude-opus-4-7', max_input_tokens: OWN }],
          }),
    );
    vi.stubGlobal('fetch', spy);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await fetchProviderModels(OWNER, 'anthropic', { keyId: KEY });
      expect(anthropicCalls(spy)).toBe(1);
      // Fresh for 5 minutes (age under the TTL): the form's list is served.
      vi.setSystemTime(Date.now() + 5 * 60_000 - 1);
      await fetchProviderModels(OWNER, 'anthropic', { keyId: KEY });
      expect(anthropicCalls(spy)).toBe(1);
      // Stale: the dashboard still reads the list, and asks for one refresh.
      vi.setSystemTime(Date.now() + 2);
      fail = true;
      expect(await agentContextWindow(OWNER, agent('claude-opus-4-7'))).toEqual({
        limit: OWN,
        source: 'live',
      });
      await settle();
      expect(anthropicCalls(spy)).toBe(2);
      // The refresh failed: the stale list still answers, and no new try
      // inside the backoff.
      expect(await agentContextWindow(OWNER, agent('claude-opus-4-7'))).toEqual({
        limit: OWN,
        source: 'live',
      });
      await settle();
      expect(anthropicCalls(spy)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('an agent on its own host (fix round 2 L1)', () => {
  it("never sends its key to the provider's public host; reads the mapping", async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const got = await agentContextWindow(OWNER, {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKeyId: KEY,
      baseUrl: 'https://gateway.example.test/v1',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(got.limit).toBe(contextLimitFor('anthropic/claude-opus-4.7'));
    expect(spy.mock.calls.filter(([url]) => !String(url).includes('openrouter.ai'))).toEqual([]);
  });
});
