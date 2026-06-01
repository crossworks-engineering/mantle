/**
 * Tests for the chat adapter framework + xAI/HF adapters.
 *
 * The HTTP-calling code (actual /v1/chat/completions calls) needs
 * real API keys and is exercised via integration. Here we lock down:
 *
 *   1. Built-in chat adapters self-register for xai and huggingface.
 *   2. Static catalogs are non-empty and contain the documented
 *      headline models (grok-4.3 for xAI, common open models for HF).
 *   3. The HF routing suffix helper applies / preserves correctly.
 *   4. `isProviderWired('xai', 'chat')` returns true now that an
 *      adapter is registered, false for unknown providers.
 *   5. The adapter exposes its static catalog through the helper so
 *      the UI can render before discovery completes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_CHAT_MODELS,
  HUGGINGFACE_CHAT_MODELS,
  OPENROUTER_CHAT_MODELS,
  XAI_CHAT_MODELS,
  anthropicChatAdapter,
  deepseekChatAdapter,
  getChatAdapter,
  huggingfaceChatAdapter,
  isProviderWired,
  listChatAdapters,
  openrouterChatAdapter,
  xaiChatAdapter,
} from './index';
import { applyRoutingSuffix } from './huggingface-chat';

describe('chat adapter self-registration', () => {
  it('registers xai-chat on import', () => {
    const a = getChatAdapter('xai');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('xai-chat');
    // getChatAdapter returns a retry-wrapped dispatcher for direct providers
    // (not the raw export ref), so assert resolution by identity, not ===.
    expect(a?.providerId).toBe(xaiChatAdapter.providerId);
  });

  it('registers huggingface-chat on import', () => {
    const a = getChatAdapter('huggingface');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('huggingface-chat');
    expect(a?.providerId).toBe(huggingfaceChatAdapter.providerId);
  });

  it('registers openrouter-chat on import', () => {
    const a = getChatAdapter('openrouter');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('openrouter-chat');
    expect(a).toBe(openrouterChatAdapter);
  });

  it('registers deepseek-chat on import', () => {
    const a = getChatAdapter('deepseek');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('deepseek-chat');
    expect(a?.providerId).toBe(deepseekChatAdapter.providerId);
  });

  it('lists at least two chat adapters', () => {
    // Lock the count low — guarantees we registered both built-ins.
    // If someone adds a third (anthropic-chat, grok-vision, etc.)
    // this still passes.
    expect(listChatAdapters().length).toBeGreaterThanOrEqual(2);
  });
});

describe('xAI catalog', () => {
  it('includes grok-4.3 (current default model)', () => {
    expect(XAI_CHAT_MODELS.some((m) => m.id === 'grok-4.3')).toBe(true);
  });

  it('every entry has label + description (non-trivial)', () => {
    for (const m of XAI_CHAT_MODELS) {
      expect(m.label.length, `${m.id}.label`).toBeGreaterThan(0);
      expect(m.description.length, `${m.id}.description`).toBeGreaterThan(10);
    }
  });

  it('reasoning variants declare the reasoning capability', () => {
    // Reasoning support is what makes grok-4.20-reasoning distinct
    // from the non-reasoning variant. UI relies on the capability
    // flag to show/hide the reasoning_effort knob.
    const reasoning = XAI_CHAT_MODELS.find((m) => m.id.includes('reasoning'));
    expect(reasoning?.capabilities).toContain('reasoning');
  });
});

describe('Hugging Face catalog', () => {
  it('includes a notable open model from each family we care about', () => {
    const ids = HUGGINGFACE_CHAT_MODELS.map((m) => m.id);
    // Lock down the rough shape — these families are the headline
    // open-weights names we'd defend in code review. Specific model
    // versions may move forward as HF expands; the family stays.
    expect(ids.some((id) => id.startsWith('openai/gpt-oss'))).toBe(true);
    expect(ids.some((id) => id.startsWith('deepseek-ai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('meta-llama/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('mistralai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('Qwen/'))).toBe(true);
  });

  it('includes a vision-capable model (for whiteboard / OCR use cases)', () => {
    expect(HUGGINGFACE_CHAT_MODELS.some((m) => m.capabilities?.includes('vision'))).toBe(true);
  });
});

describe('applyRoutingSuffix (Hugging Face)', () => {
  it('appends the policy suffix when no colon is present', () => {
    expect(applyRoutingSuffix('openai/gpt-oss-120b', 'fastest')).toBe(
      'openai/gpt-oss-120b:fastest',
    );
    expect(applyRoutingSuffix('openai/gpt-oss-120b', 'cheapest')).toBe(
      'openai/gpt-oss-120b:cheapest',
    );
  });

  it('preserves a user-specified suffix (pinned sub-provider)', () => {
    // If the user typed `model:groq` explicitly, we don't second-guess
    // them — even with a 'fastest' policy on the worker.
    expect(applyRoutingSuffix('openai/gpt-oss-120b:groq', 'fastest')).toBe(
      'openai/gpt-oss-120b:groq',
    );
  });

  it('returns the id unchanged when no policy is provided', () => {
    // No policy → HF defaults to :fastest server-side. We don't need
    // to tag it explicitly.
    expect(applyRoutingSuffix('openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b');
  });
});

describe('isProviderWired for chat', () => {
  it('returns true for xai+chat (adapter registered)', () => {
    expect(isProviderWired('xai', 'chat')).toBe(true);
  });

  it('returns true for huggingface+chat (adapter registered)', () => {
    expect(isProviderWired('huggingface', 'chat')).toBe(true);
  });

  it('returns true for openrouter+chat (adapter registered, no longer the special case)', () => {
    // OpenRouter chat now flows through the adapter registry like
    // every other provider — see openrouter-chat.ts. The legacy
    // direct-SDK carve-out in registry.ts went away with Pre-work B
    // of the Phase 3 push.
    expect(isProviderWired('openrouter', 'chat')).toBe(true);
  });

  it('returns false for openai+chat (no direct adapter — reached via OpenRouter)', () => {
    // There is no direct openai-chat adapter; OpenAI chat is reached through the
    // openrouter provider with an `openai/*` model. The old carve-out marked
    // openai chat-wired, which surfaced it in the dropdown but with no models —
    // confusing. It's now honestly not wired.
    expect(isProviderWired('openai', 'chat')).toBe(false);
  });

  it('returns false for unknown chat providers', () => {
    expect(isProviderWired('made-up', 'chat')).toBe(false);
  });
});

describe('staticCatalog hook', () => {
  it('xai adapter exposes its catalog through the hook', () => {
    expect(xaiChatAdapter.staticCatalog?.()).toBe(XAI_CHAT_MODELS);
  });

  it('huggingface adapter exposes its catalog through the hook', () => {
    expect(huggingfaceChatAdapter.staticCatalog?.()).toBe(HUGGINGFACE_CHAT_MODELS);
  });
});

// ─── cache_control flow + usage round-trip ─────────────────────────────────
//
// These mock fetch and verify the body Anthropic actually sees + the
// ChatResult round-trip carries cache_read / cache_write counts through.
// Distinct from the integration tests in catch-all suites — these lock
// down the translation logic that has the most provider-specific bite.

function mockAnthropicFetch(body: Record<string, unknown>) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('anthropic-chat cache_control translation', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // Each test installs its own mock — the global swap here just
    // ensures restoration even on test bailout.
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('keeps system as a plain string when no cacheControl is set', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') });
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }], model: 'claude-haiku-4-5', usage: {} }) };
    }) as unknown as typeof fetch;
    await anthropicChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'you are saskia' },
        { role: 'user', content: 'hi' },
      ],
    });
    const sent = JSON.parse(calls[0]!.body);
    expect(sent.system).toBe('you are saskia');
  });

  it('wraps system in a content-block array with cache_control when cacheControl.systemPrompt is set', async () => {
    const calls: Array<{ body: string }> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push({ body: String(init?.body ?? '') });
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }], model: 'claude-haiku-4-5', usage: {} }) };
    }) as unknown as typeof fetch;
    await anthropicChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'you are saskia' },
        { role: 'user', content: 'hi' },
      ],
      cacheControl: { systemPrompt: true },
    });
    const sent = JSON.parse(calls[0]!.body);
    expect(sent.system).toEqual([
      { type: 'text', text: 'you are saskia', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('marks only the LAST user message when cacheControl.lastUserMessage is set', async () => {
    const calls: Array<{ body: string }> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push({ body: String(init?.body ?? '') });
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }], model: 'claude-haiku-4-5', usage: {} }) };
    }) as unknown as typeof fetch;
    await anthropicChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      cacheControl: { lastUserMessage: true },
    });
    const sent = JSON.parse(calls[0]!.body);
    // First user message stays a plain string; last user is wrapped.
    expect(sent.messages[0]).toEqual({ role: 'user', content: 'first' });
    expect(sent.messages[1]).toEqual({ role: 'assistant', content: 'reply' });
    expect(sent.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('round-trips cache_read_input_tokens and cache_creation_input_tokens onto ChatResult', async () => {
    globalThis.fetch = mockAnthropicFetch({
      content: [{ type: 'text', text: 'hello' }],
      model: 'claude-haiku-4-5',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 50,
      },
    });
    const result = await anthropicChatAdapter.chat({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(20);
    expect(result.cacheReadTokens).toBe(800);
    expect(result.cacheWriteTokens).toBe(50);
  });
});

describe('deepseek catalog', () => {
  it('includes the V4 generation (current default)', () => {
    const ids = DEEPSEEK_CHAT_MODELS.map((m) => m.id);
    expect(ids).toContain('deepseek-v4-pro');
    expect(ids).toContain('deepseek-v4-flash');
  });

  it('keeps the legacy aliases until their 2026-07-24 deprecation', () => {
    const ids = DEEPSEEK_CHAT_MODELS.map((m) => m.id);
    expect(ids).toContain('deepseek-chat');
    expect(ids).toContain('deepseek-reasoner');
  });

  it('every entry has label + description', () => {
    for (const m of DEEPSEEK_CHAT_MODELS) {
      expect(m.label.length, `${m.id}.label`).toBeGreaterThan(0);
      expect(m.description.length, `${m.id}.description`).toBeGreaterThan(10);
    }
  });
});

describe('openrouter catalog', () => {
  it('includes anthropic/claude-sonnet-4.6 (responder default)', () => {
    expect(
      OPENROUTER_CHAT_MODELS.some((m) => m.id === 'anthropic/claude-sonnet-4.6'),
    ).toBe(true);
  });

  it('includes a mix of headline providers (anthropic + openai + google + xai)', () => {
    const ids = OPENROUTER_CHAT_MODELS.map((m) => m.id);
    expect(ids.some((id) => id.startsWith('anthropic/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('openai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('google/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('x-ai/'))).toBe(true);
  });

  it('every entry has label + description', () => {
    for (const m of OPENROUTER_CHAT_MODELS) {
      expect(m.label.length, `${m.id}.label`).toBeGreaterThan(0);
      expect(m.description.length, `${m.id}.description`).toBeGreaterThan(10);
    }
  });
});

describe('xai-chat usage round-trip', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('surfaces prompt_tokens_details.cached_tokens as cacheReadTokens', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        model: 'grok-4.3',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: {
          prompt_tokens: 200,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 150 },
        },
      }),
    })) as unknown as typeof fetch;
    const result = await xaiChatAdapter.chat({
      apiKey: 'xai-test',
      model: 'grok-4.3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.cacheReadTokens).toBe(150);
    expect(result.cacheWriteTokens).toBeUndefined();
  });
});
