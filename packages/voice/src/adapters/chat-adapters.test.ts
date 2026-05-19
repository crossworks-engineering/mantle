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

import { describe, expect, it } from 'vitest';
import {
  HUGGINGFACE_CHAT_MODELS,
  XAI_CHAT_MODELS,
  getChatAdapter,
  huggingfaceChatAdapter,
  isProviderWired,
  listChatAdapters,
  xaiChatAdapter,
} from './index';
import { applyRoutingSuffix } from './huggingface-chat';

describe('chat adapter self-registration', () => {
  it('registers xai-chat on import', () => {
    const a = getChatAdapter('xai');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('xai-chat');
    expect(a).toBe(xaiChatAdapter);
  });

  it('registers huggingface-chat on import', () => {
    const a = getChatAdapter('huggingface');
    expect(a).not.toBeNull();
    expect(a?.adapterName).toBe('huggingface-chat');
    expect(a).toBe(huggingfaceChatAdapter);
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

  it('still returns true for openrouter+chat (legacy direct-SDK path)', () => {
    // OpenRouter chat doesn't go through the adapter registry; it's
    // called inline via the OpenRouter SDK in the agent runtime.
    // Treated as wired by convention so the UI doesn't show the
    // amber warning for the workers that use OpenRouter today.
    expect(isProviderWired('openrouter', 'chat')).toBe(true);
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
