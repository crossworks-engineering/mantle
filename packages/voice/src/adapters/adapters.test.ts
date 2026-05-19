/**
 * Tests for the adapter registry. The actual HTTP-calling work in
 * each adapter (synthesize/transcribe) needs a real API key to test
 * end-to-end and is exercised via integration; here we lock down
 * the registry contract that production code depends on:
 *
 *   1. Built-in adapters self-register when @mantle/voice is imported.
 *   2. `getTtsAdapter('openai')` returns a non-null dispatcher with
 *      the right providerId + adapterName.
 *   3. `isProviderWired` reflects what's actually in the registry.
 *   4. Looking up an unknown provider returns null (no nil-throw).
 *   5. A registered adapter can be re-registered (used by tests + by
 *      runtime hot-swaps if we ever build them).
 */

import { describe, expect, it } from 'vitest';
import {
  getSttAdapter,
  getTtsAdapter,
  isProviderWired,
  listSttAdapters,
  listTtsAdapters,
  openAiSttAdapter,
  openAiTtsAdapter,
  registerTtsAdapter,
  type TtsDispatcher,
} from './index';

describe('built-in adapter self-registration', () => {
  it('registers openai-tts on import', () => {
    const a = getTtsAdapter('openai');
    expect(a).not.toBeNull();
    expect(a?.providerId).toBe('openai');
    expect(a?.adapterName).toBe('openai-tts');
    // The adapter object is the same singleton exported from the
    // module — both routes (registry lookup, direct import) hand
    // back the same reference, so monkey-patching for tests is
    // consistent.
    expect(a).toBe(openAiTtsAdapter);
  });

  it('registers openai-stt on import', () => {
    const a = getSttAdapter('openai');
    expect(a).not.toBeNull();
    expect(a?.providerId).toBe('openai');
    expect(a?.adapterName).toBe('openai-stt');
    expect(a).toBe(openAiSttAdapter);
  });

  it('lists at least one adapter per built-in capability', () => {
    expect(listTtsAdapters().length).toBeGreaterThan(0);
    expect(listSttAdapters().length).toBeGreaterThan(0);
  });
});

describe('isProviderWired', () => {
  it('returns true for openai+tts (built-in)', () => {
    expect(isProviderWired('openai', 'tts')).toBe(true);
  });

  it('returns true for openai+stt (built-in)', () => {
    expect(isProviderWired('openai', 'stt')).toBe(true);
  });

  it('returns false for catalogued-but-unwired providers', () => {
    // Deepgram is in the catalog but has no STT adapter yet — UI
    // shows "not yet wired" hint via this check. If/when we wire it,
    // this assertion breaks loudly and we update it.
    expect(isProviderWired('deepgram', 'stt')).toBe(false);
  });

  it('returns false for completely unknown providers', () => {
    // Defensive — a free-text value in api_keys.service mustn't crash
    // the page.
    expect(isProviderWired('made-up-provider', 'tts')).toBe(false);
  });

  it('treats openrouter + openai as chat-wired by convention', () => {
    // Chat doesn't route through the adapter registry today — agents
    // call the OpenRouter SDK directly. We hardcode chat-wired status
    // for the two providers we use; future providers stay un-wired
    // until their dispatch lands.
    expect(isProviderWired('openrouter', 'chat')).toBe(true);
    expect(isProviderWired('openai', 'chat')).toBe(true);
    // Anthropic, xai, google, huggingface are NOW wired (see new-
    // providers.test.ts and chat-adapters.test.ts). Pick a provider
    // we know we'll keep un-wired for the foreseeable future to
    // exercise the "not registered" branch.
    expect(isProviderWired('deepseek', 'chat')).toBe(false);
  });
});

describe('registerTtsAdapter', () => {
  it('can register a custom adapter at runtime (used for tests + future hot-swaps)', () => {
    const fake: TtsDispatcher = {
      providerId: 'huggingface' as const,
      adapterName: 'hf-test',
      async synthesize() {
        return {
          bytes: Buffer.from('fake'),
          mimeType: 'audio/mpeg',
          voice: 'nova',
          model: 'fake',
        };
      },
    };
    registerTtsAdapter(fake);
    expect(getTtsAdapter('huggingface')).toBe(fake);
    expect(isProviderWired('huggingface', 'tts')).toBe(true);
  });
});

describe('adapter unknown lookup', () => {
  it('returns null (not undefined, not throw) for unknown providers', () => {
    expect(getTtsAdapter('not-a-provider')).toBeNull();
    expect(getSttAdapter('not-a-provider')).toBeNull();
  });
});
